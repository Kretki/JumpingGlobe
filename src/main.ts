import { LandLoader, bboxContains, viewBBox, viewHalfAngle, visibleGroundRadiusDeg, type BBox } from "./land/loader";
import { WORLD_FILE, featureLimitFromHeight, lodFileFromHeight, minAreaFromHeight } from "./land/lod.config";
import type { LandMesh } from "./land/mesh";
import { preparePlateMesh, reconstruct, type PlateMesh, type ReconstructStats } from "./plates/reconstruct";
import { RotationTree, type RotationModel } from "./plates/rotation";
import { Timeline } from "./plates/timeline";
import {
  computeTrack,
  formatLonLat,
  lonLatToUnit,
  parseStaticPolygons,
  plateAt,
  positionAt,
  unitToLonLat,
  type StaticPolygon,
  type TrackedPoint,
} from "./plates/pointTrack";

const canvas = document.getElementById("gl") as HTMLCanvasElement;
const coordsEl = document.getElementById("coords") as HTMLDivElement;
const gl = canvas.getContext("webgl");
if (!gl) throw new Error("WebGL not supported");

const uint32Ext = gl.getExtension("OES_element_index_uint");
if (!uint32Ext) console.warn("OES_element_index_uint missing — large land meshes may fail");

// WGS84 ellipsoid (meters), Z = north pole
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

const MIN_HEIGHT = 50;
const MAX_HEIGHT = 2e7;

const vsSource = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uMVP;
uniform mat4 uModel;
varying vec3 vNormal;
varying vec3 vWorldPos;

void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorldPos = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  gl_Position = uMVP * vec4(aPosition, 1.0);
}
`;

const fsSource = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float; // lon/lat clip test needs more than mediump's ~0.1°
#else
precision mediump float;
#endif
varying vec3 vNormal;
varying vec3 vWorldPos;
uniform vec3 uCameraPos;
uniform vec3 uBaseColor;
uniform float uClipLand;  // 0 none · 1 lon/lat box · 2 spherical cap
uniform vec4 uClipBBox;
uniform vec4 uClipCap;    // cap centre (unit vector, GPlates sphere) + cos(radius)

void main() {
  if (uClipLand > 0.5) {
    float lonR = atan(vWorldPos.y, vWorldPos.x);
    // Geodetic latitude (same as the EPSG:4326 data); for near-surface points
    // tan(geodetic) = z / ((1 - e²) p). Geocentric would be off by up to 0.19°.
    float latR = atan(vWorldPos.z, 0.99330562 * length(vWorldPos.xy));
    if (uClipLand < 1.5) {
      float lon = lonR * 57.2957795;
      float lat = latR * 57.2957795;
      bool inLat = lat >= uClipBBox.y && lat <= uClipBBox.w;
      bool inLon = uClipBBox.x <= uClipBBox.z
        ? (lon >= uClipBBox.x && lon <= uClipBBox.z)
        : (lon >= uClipBBox.x || lon <= uClipBBox.z);
      if (inLat && inLon) discard;
    } else {
      vec3 u = vec3(cos(latR) * cos(lonR), cos(latR) * sin(lonR), sin(latR));
      if (dot(u, uClipCap.xyz) >= uClipCap.w) discard;
    }
  }

  // Lit evenly from all directions: no sun, so no dark side or hot spot; a soft
  // view-facing term keeps the globe readable as a sphere.
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCameraPos - vWorldPos);
  float facing = max(dot(n, v), 0.0);
  gl_FragColor = vec4(uBaseColor * (0.8 + 0.2 * facing), 1.0);
}
`;

function compile(type: number, source: string): WebGLShader {
  const shader = gl!.createShader(type)!;
  gl!.shaderSource(shader, source);
  gl!.compileShader(shader);
  if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
    const info = gl!.getShaderInfoLog(shader);
    gl!.deleteShader(shader);
    throw new Error(info || "Shader compile failed");
  }
  return shader;
}

function createProgram(vs: string, fs: string): WebGLProgram {
  const program = gl!.createProgram()!;
  gl!.attachShader(program, compile(gl!.VERTEX_SHADER, vs));
  gl!.attachShader(program, compile(gl!.FRAGMENT_SHADER, fs));
  gl!.linkProgram(program);
  if (!gl!.getProgramParameter(program, gl!.LINK_STATUS)) {
    throw new Error(gl!.getProgramInfoLog(program) || "Program link failed");
  }
  return program;
}

/** Geocentric parametric ellipsoid mesh (WGS84). */
function createEllipsoid(latBands: number, longBands: number) {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const a2 = WGS84_A * WGS84_A;
  const b2 = WGS84_B * WGS84_B;

  for (let lat = 0; lat <= latBands; lat++) {
    const theta = (lat * Math.PI) / latBands;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);

    for (let lon = 0; lon <= longBands; lon++) {
      const phi = (lon * 2 * Math.PI) / longBands;
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);

      const x = WGS84_A * sinT * cosP;
      const y = WGS84_A * sinT * sinP;
      const z = WGS84_B * cosT;

      positions.push(x, y, z);

      const nx = x / a2;
      const ny = y / a2;
      const nz = z / b2;
      const nlen = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / nlen, ny / nlen, nz / nlen);
    }
  }

  for (let lat = 0; lat < latBands; lat++) {
    for (let lon = 0; lon < longBands; lon++) {
      const first = lat * (longBands + 1) + lon;
      const second = first + longBands + 1;
      indices.push(first, second, first + 1);
      indices.push(second, second + 1, first + 1);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  };
}

function ellipsoidRadius(dx: number, dy: number, dz: number): number {
  const len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  return 1 / Math.sqrt((ux * ux + uy * uy) / (WGS84_A * WGS84_A) + (uz * uz) / (WGS84_B * WGS84_B));
}

function ecefToGeodetic(x: number, y: number, z: number) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  for (let i = 0; i < 8; i++) {
    const sinLat = Math.sin(lat);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    lat = Math.atan2(z + WGS84_E2 * N * sinLat, p);
  }
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const h = Math.abs(cosLat) > 1e-10 ? p / cosLat - N : Math.abs(z) / Math.abs(sinLat) - N * (1 - WGS84_E2);
  return {
    lat: (lat * 180) / Math.PI,
    lon: (lon * 180) / Math.PI,
    h,
  };
}

type Mat4 = Float32Array;

function mat4Identity(): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

function mat4LookAt(eye: number[], center: number[], up: number[]): Mat4 {
  const [ex, ey, ez] = eye;
  let zx = ex - center[0];
  let zy = ey - center[1];
  let zz = ez - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len;
  zy /= len;
  zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len;
  xy /= len;
  xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  const out = mat4Identity();
  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  return out;
}

function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] =
        a[j] * b[i * 4] +
        a[4 + j] * b[i * 4 + 1] +
        a[8 + j] * b[i * 4 + 2] +
        a[12 + j] * b[i * 4 + 3];
    }
  }
  return out;
}

const program = createProgram(vsSource, fsSource);
const ellipsoid = createEllipsoid(64, 96);

const posBuf = gl.createBuffer()!;
gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
gl.bufferData(gl.ARRAY_BUFFER, ellipsoid.positions, gl.STATIC_DRAW);

const nrmBuf = gl.createBuffer()!;
gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
gl.bufferData(gl.ARRAY_BUFFER, ellipsoid.normals, gl.STATIC_DRAW);

const idxBuf = gl.createBuffer()!;
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ellipsoid.indices, gl.STATIC_DRAW);

type LandSlot = {
  pos: WebGLBuffer;
  nrm: WebGLBuffer;
  idx: WebGLBuffer;
  indexCount: number;
};

function makeLandSlot(): LandSlot {
  return {
    pos: gl!.createBuffer()!,
    nrm: gl!.createBuffer()!,
    idx: gl!.createBuffer()!,
    indexCount: 0,
  };
}

const baseSlot = makeLandSlot();
const detailSlot = makeLandSlot();
/**
 * Where the base (world) mesh is hidden because detail covers it: a lon/lat box
 * for present-day tiles, a spherical cap around the view centre in the past.
 */
type LandClip = { kind: "bbox"; bbox: BBox } | { kind: "cap"; center: [number, number, number]; cosR: number };
let detailClip: LandClip | null = null;
let loadedViewBBox: BBox | null = null;

function uploadSlot(slot: LandSlot, mesh: LandMesh) {
  gl!.bindBuffer(gl!.ARRAY_BUFFER, slot.pos);
  gl!.bufferData(gl!.ARRAY_BUFFER, mesh.positions, gl!.STATIC_DRAW);
  gl!.bindBuffer(gl!.ARRAY_BUFFER, slot.nrm);
  gl!.bufferData(gl!.ARRAY_BUFFER, mesh.normals, gl!.STATIC_DRAW);
  gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, slot.idx);
  gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, mesh.indices, gl!.STATIC_DRAW);
  slot.indexCount = mesh.indices.length;
}

/** Upload a reconstructed plate mesh (indices only change when the mesh does). */
function uploadPlateSlot(slot: LandSlot, pm: PlateMesh, indicesChanged: boolean) {
  gl!.bindBuffer(gl!.ARRAY_BUFFER, slot.pos);
  gl!.bufferData(gl!.ARRAY_BUFFER, pm.positions, gl!.DYNAMIC_DRAW);
  gl!.bindBuffer(gl!.ARRAY_BUFFER, slot.nrm);
  gl!.bufferData(gl!.ARRAY_BUFFER, pm.normals, gl!.DYNAMIC_DRAW);
  if (indicesChanged) {
    gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, slot.idx);
    gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, pm.indices, gl!.STATIC_DRAW);
    slot.indexCount = pm.indices.length;
  }
}

function clearSlot(slot: LandSlot) {
  if (slot.indexCount === 0) return;
  gl!.bindBuffer(gl!.ARRAY_BUFFER, slot.pos);
  gl!.bufferData(gl!.ARRAY_BUFFER, 1, gl!.STATIC_DRAW);
  gl!.bindBuffer(gl!.ARRAY_BUFFER, slot.nrm);
  gl!.bufferData(gl!.ARRAY_BUFFER, 1, gl!.STATIC_DRAW);
  gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, slot.idx);
  gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, 1, gl!.STATIC_DRAW);
  slot.indexCount = 0;
}

function destroySlot(slot: LandSlot) {
  clearSlot(slot);
  gl!.deleteBuffer(slot.pos);
  gl!.deleteBuffer(slot.nrm);
  gl!.deleteBuffer(slot.idx);
}

const aPosition = gl.getAttribLocation(program, "aPosition");
const aNormal = gl.getAttribLocation(program, "aNormal");
const uMVP = gl.getUniformLocation(program, "uMVP");
const uModel = gl.getUniformLocation(program, "uModel");
const uCameraPos = gl.getUniformLocation(program, "uCameraPos");
const uBaseColor = gl.getUniformLocation(program, "uBaseColor");
const uClipLand = gl.getUniformLocation(program, "uClipLand");
const uClipBBox = gl.getUniformLocation(program, "uClipBBox");
const uClipCap = gl.getUniformLocation(program, "uClipCap");

let yaw = 0.6;
let pitch = 0.35;
let height = 1e7;
let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointerup", () => {
  dragging = false;
});

const FOVY = (45 * Math.PI) / 180;

function orbitRadiansPerPixel(): number {
  const h = Math.max(canvas.clientHeight, 1);
  const metersPerPixel = (2 * height * Math.tan(FOVY / 2)) / h;
  const [dx, dy, dz] = viewDir();
  const R = ellipsoidRadius(dx, dy, dz);
  return metersPerPixel / R;
}

function zoomGain(): number {
  const t = Math.log(height / MIN_HEIGHT) / Math.log(MAX_HEIGHT / MIN_HEIGHT);
  return 0.00045 + t * 0.0014;
}

canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  const k = orbitRadiansPerPixel();
  yaw += dx * k;
  pitch = Math.max(-1.4, Math.min(1.4, pitch + dy * k));
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * zoomGain());
    height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height * factor));
  },
  { passive: false }
);

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    gl!.viewport(0, 0, w, h);
  }
}

function viewDir(): number[] {
  const cp = Math.cos(pitch);
  return [cp * Math.sin(yaw), cp * Math.cos(yaw), Math.sin(pitch)];
}

function cameraPos(): number[] {
  const [dx, dy, dz] = viewDir();
  const R = ellipsoidRadius(dx, dy, dz);
  const r = R + height;
  return [dx * r, dy * r, dz * r];
}

function lookAtSurfacePoint(): number[] {
  const [dx, dy, dz] = viewDir();
  const R = ellipsoidRadius(dx, dy, dz);
  return [dx * R, dy * R, dz * R];
}

function fmt(n: number, digits: number): string {
  return n.toFixed(digits);
}

const progressEl = document.getElementById("land-progress") as HTMLDivElement;
const progressFill = document.getElementById("land-progress-fill") as HTMLElement;
const progressLabel = document.getElementById("land-progress-label") as HTMLDivElement;
const progressPct = progressEl.querySelector(".pct") as HTMLSpanElement;
let progressHideTimer = 0;
let landLoadPercent = 0;
let landLoading = false;

function setLandProgress(percent: number, label: string, visible: boolean) {
  landLoadPercent = Math.max(0, Math.min(100, Math.round(percent)));
  landLoading = visible && landLoadPercent < 100;
  progressPct.textContent = `${landLoadPercent}%`;
  progressFill.style.width = `${landLoadPercent}%`;
  progressLabel.textContent = label;
  if (visible) {
    progressEl.classList.add("visible");
    window.clearTimeout(progressHideTimer);
    if (landLoadPercent >= 100) {
      progressHideTimer = window.setTimeout(() => {
        progressEl.classList.remove("visible");
        landLoading = false;
      }, 900);
    }
  } else if (landLoadPercent >= 100 || label === "Idle") {
    progressEl.classList.remove("visible");
    landLoading = false;
  }
}

const landLoader = new LandLoader("/api", (p) => {
  const show = p.phase !== "idle" && p.phase !== "done";
  const keepVisible = p.phase === "done" || show;
  setLandProgress(p.percent, p.label, keepVisible);
  if (p.phase !== "done" && p.phase !== "idle") {
    landStatus = `${p.label} · ${Math.round(p.percent)}%`;
  }
});

let landStatus = "loading…";

// ---- Plate reconstruction (Merdith et al. 2021) ----
let rotationTree: RotationTree | null = null;
let rotationModelError = false;
let currentAge = 0;
let ageDirty = false;
let basePlates: PlateMesh | null = null;
/** Past-time detail mesh (plate-tagged, present-day coordinates). */
let detailPlates: PlateMesh | null = null;
/** What the past detail covers: view centre/radius at an age (GPlates sphere). */
let loadedPast: { file: string; age: number; lon: number; lat: number; radiusDeg: number } | null = null;
/** Server-side plate layers: "building" on first start, then "ready". */
let plateStatus: { status: string; detail: string } = { status: "loading", detail: "" };
/** LOD file -> plate-tagged twin, for twins the server has finished. */
let plateFiles: Record<string, string> = {};
let staticFile: string | null = null;
let lastReconstruct: { base?: ReconstructStats } = {};
const plateWorldLoader = new LandLoader("/api");

const timeline = new Timeline((age) => {
  currentAge = age;
  ageDirty = true;
  // Detail is valid for one age only; a paused timeline reloads it (scheduleLandLoad).
  if (detailSlot.indexCount > 0 || loadedPast || (age > 0 && lastLoadFile !== WORLD_FILE)) clearDetail();
});

type PlateStatusResponse = {
  status: "ready" | "building" | "failed" | "unavailable";
  detail: string;
  plateFiles: Record<string, string>;
  staticFile: string | null;
};

async function loadRotationModel() {
  try {
    const res = await fetch("/api/rotations");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const model = (await res.json()) as RotationModel;
    rotationTree = new RotationTree(model);
    timeline.enable(Math.round(model.maxAge));
    ageDirty = true;
    void pollPlateLayers();
  } catch (err) {
    console.warn("rotation model unavailable", err);
    rotationModelError = true;
  }
  updateTimelineStatus();
}

/** Follow the server's background build: world twin first (seconds), detail twins later. */
async function pollPlateLayers() {
  let worldRequested = false;
  while (!landDisposed) {
    let st: PlateStatusResponse;
    try {
      const res = await fetch("/api/plates/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      st = (await res.json()) as PlateStatusResponse;
    } catch (err) {
      plateStatus = { status: "failed", detail: String(err) };
      updateTimelineStatus();
      return;
    }
    plateStatus = { status: st.status, detail: st.detail };
    plateFiles = st.plateFiles ?? {};
    staticFile = st.staticFile;
    const worldTwin = plateFiles[WORLD_FILE];
    if (worldTwin && !worldRequested) {
      worldRequested = true;
      void loadPlateWorld(worldTwin);
    }
    updateTimelineStatus();
    if (st.status !== "building") return;
    await new Promise((r) => window.setTimeout(r, 3000));
  }
}

/** Swap the base world layer for its plate-tagged twin (same land, cut along plates). */
async function loadPlateWorld(file: string) {
  const result = await plateWorldLoader.loadWorld(file);
  if (landDisposed || !result) return;
  setBasePlates(result.mesh);
  if (detailSlot.indexCount === 0) landStatus = resultStatus("world ", result);
}

function setBasePlates(mesh: LandMesh) {
  basePlates = preparePlateMesh(mesh);
  lastReconstruct.base = reconstruct(basePlates, rotationTree, currentAge);
  uploadPlateSlot(baseSlot, basePlates, true);
  updateTimelineStatus();
}

/** Re-pose the plate-tagged layers for the current age (once per frame at most). */
function applyAge() {
  if (!ageDirty) return;
  ageDirty = false;
  if (basePlates) {
    lastReconstruct.base = reconstruct(basePlates, rotationTree, currentAge);
    uploadPlateSlot(baseSlot, basePlates, false);
  }
  updateSelectionPanel();
  updateTimelineStatus();
}

function updateTimelineStatus() {
  const notes: string[] = [];
  if (rotationModelError) notes.push("Rotation model unavailable — is the API server running (npm run server)?");
  else if (plateStatus.status === "failed" || plateStatus.status === "unavailable") {
    notes.push(`Plate layers unavailable: ${plateStatus.detail || plateStatus.status} (see public/data/lods/merdith_prep.log)`);
  } else if (!plateFiles[WORLD_FILE]) notes.push("Preparing plate layers…");
  if ((lastReconstruct.base?.noRotation ?? 0) > 0 && currentAge > 0) {
    notes.push("Some plates have no rotation poles at this age (hidden)");
  }
  if (currentAge > 0) {
    const file = lodFileFromHeight(height);
    if (file !== WORLD_FILE) {
      if (timeline.isPlaying) notes.push("Pause to load detail at this age");
      else if (!plateFiles[file]) notes.push(`Detail for this zoom in the past is still being prepared (${file})`);
    }
  }
  timeline.setStatus(notes.join(" · "));
}

function angularDistanceDeg(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const a = lonLatToUnit(lon1, lat1);
  const b = lonLatToUnit(lon2, lat2);
  return (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
}

/**
 * Paused in the past: load detail of the plate-tagged LOD around the view centre
 * as it was at the current age. The server rotates the view cap back to
 * present-day coordinates per plate; the mesh is then reconstructed here.
 */
function schedulePastLoad(lon: number, lat: number, h: number, file: string, twin: string) {
  const halfAngle = viewHalfAngle(FOVY, canvas.width / Math.max(canvas.height, 1));
  const visR = visibleGroundRadiusDeg(h, halfAngle);
  const age = currentAge;
  if (loadedPast && loadedPast.file === twin && loadedPast.age === age && detailSlot.indexCount > 0) {
    // Still inside the loaded cap with a 5% margin: nothing to do.
    if (angularDistanceDeg(lon, lat, loadedPast.lon, loadedPast.lat) + visR * 1.05 <= loadedPast.radiusDeg) return;
  }
  if (lon === lastQueuedLon && lat === lastQueuedLat && h === lastQueuedH) return;
  lastQueuedLon = lon;
  lastQueuedLat = lat;
  lastQueuedH = h;

  window.clearTimeout(landLoadTimer);
  landLoadTimer = window.setTimeout(async () => {
    if (landDisposed || timeline.isPlaying || currentAge !== age || !rotationTree) return;
    const radiusDeg = Math.min(90, visR * 1.3 + 0.02);
    setLandProgress(0, "Starting…", true);
    landStatus = "loading…";
    const result = await landLoader.loadPast({
      file: twin,
      age,
      lon,
      lat,
      radiusDeg,
      heightM: h,
      minArea: minAreaFromHeight(h),
      limit: featureLimitFromHeight(h),
    });
    if (landDisposed || !result || currentAge !== age || timeline.isPlaying) return;
    if (lodFileFromHeight(height) !== file) return;
    detailPlates = preparePlateMesh(result.mesh);
    reconstruct(detailPlates, rotationTree, age);
    uploadPlateSlot(detailSlot, detailPlates, true);
    loadedPast = { file: twin, age, lon, lat, radiusDeg };
    // Hide the world layer inside the cap the detail fully covers.
    detailClip = { kind: "cap", center: lonLatToUnit(lon, lat), cosR: Math.cos((radiusDeg * Math.PI) / 180) };
    lastLoadFile = file;
    landStatus = resultStatus(`${age.toFixed(0)} Ma `, result);
    setLandProgress(100, landStatus, true);
  }, 250);
}

// ---- Selected point (click the globe) ----
let statics: StaticPolygon[] | null = null;
let staticsLoading: Promise<StaticPolygon[] | null> | null = null;
let selection: (TrackedPoint & { maxTrackAge: number }) | null = null;

const pointPanel = document.getElementById("point-panel") as HTMLElement;
const ppPlate = document.getElementById("pp-plate") as HTMLElement;
const ppPresent = document.getElementById("pp-present") as HTMLElement;
const ppAgeLabel = document.getElementById("pp-age-label") as HTMLElement;
const ppAt = document.getElementById("pp-at") as HTMLElement;
const ppTrack = document.getElementById("pp-track") as HTMLElement;
const ppNote = document.getElementById("pp-note") as HTMLElement;
(document.getElementById("pp-clear") as HTMLButtonElement).addEventListener("click", () => clearSelection());
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") clearSelection();
});

function loadStatics(): Promise<StaticPolygon[] | null> {
  if (statics) return Promise.resolve(statics);
  if (!staticFile) return Promise.resolve(null);
  if (!staticsLoading) {
    const params = new URLSearchParams({ file: staticFile, bbox: "-180,-90,180,90", limit: "100000", min_area: "0" });
    staticsLoading = fetch(`/api/land?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((fc) => (statics = parseStaticPolygons(fc)))
      .catch((err) => {
        console.warn("static polygons unavailable", err);
        staticsLoading = null;
        return null;
      });
  }
  return staticsLoading;
}

function clearSelection() {
  selection = null;
  pointPanel.hidden = true;
  ppNote.textContent = "";
}

async function selectAt(lon: number, lat: number) {
  if (!rotationTree) return;
  pointPanel.hidden = false;
  const list = await loadStatics();
  if (!list) {
    ppPlate.textContent = "—";
    ppNote.textContent = "Plate polygons are still being prepared — try again in a moment.";
    return;
  }
  const hit = plateAt(list, rotationTree, lon, lat, currentAge);
  if (!hit) {
    selection = null;
    ppPlate.textContent = "none";
    ppPresent.textContent = "—";
    ppAgeLabel.textContent = `At ${currentAge.toFixed(0)} Ma`;
    ppAt.textContent = formatLonLat(lon, lat);
    ppTrack.textContent = "—";
    ppNote.textContent = "No plate in the model covers this point at this age.";
    return;
  }
  const maxTrackAge = Math.min(rotationTree.maxAge, hit.poly.fromAge);
  selection = {
    plateId: hit.poly.plateId,
    name: hit.poly.name,
    fromAge: hit.poly.fromAge,
    toAge: hit.poly.toAge,
    unit0: hit.unit0,
    presentLon: hit.presentLon,
    presentLat: hit.presentLat,
    // 0.25 Myr steps keep the line smooth even through fast (~2°/Myr) motion.
    track: computeTrack(rotationTree, hit.poly, hit.unit0, maxTrackAge, 0.25),
    maxTrackAge,
  };
  ppNote.textContent = "";
  updateSelectionPanel();
  uploadTrack();
}

function updateSelectionPanel() {
  if (!selection || !rotationTree) return;
  const sel = selection;
  ppPlate.textContent = `${sel.plateId}${sel.name ? ` · ${sel.name}` : ""}`;
  ppPresent.textContent = formatLonLat(sel.presentLon, sel.presentLat);
  ppAgeLabel.textContent = `At ${currentAge.toFixed(0)} Ma`;
  const u = positionAt(rotationTree, sel, sel.unit0, currentAge);
  if (u) {
    const [lo, la] = unitToLonLat(u);
    ppAt.textContent = formatLonLat(lo, la);
  } else {
    ppAt.textContent = currentAge > sel.fromAge ? "not formed yet" : "no rotation data";
  }
  const shown = sel.track.filter((t) => t.unit).length;
  ppTrack.textContent = shown ? `0 – ${sel.maxTrackAge.toFixed(0)} Ma${shown < sel.track.length ? " (gaps)" : ""}` : "—";
}

// Click (not drag) on the globe selects a point.
let downX = 0;
let downY = 0;
let downT = 0;
canvas.addEventListener("pointerdown", (e) => {
  downX = e.clientX;
  downY = e.clientY;
  downT = performance.now();
});
canvas.addEventListener("pointerup", (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4 || performance.now() - downT > 600) return;
  const hit = pickGlobe(e.clientX, e.clientY);
  if (hit) void selectAt(hit[0], hit[1]);
});

/** Lon/lat (geodetic) of the globe surface under a client pixel, or null for space. */
function pickGlobe(clientX: number, clientY: number): [number, number] | null {
  const rect = canvas.getBoundingClientRect();
  const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
  const eye = cameraPos();
  const f = [-eye[0], -eye[1], -eye[2]];
  const fl = Math.hypot(f[0], f[1], f[2]);
  for (let i = 0; i < 3; i++) f[i] /= fl;
  const up = Math.abs(pitch) > 1.2 ? [-Math.sin(yaw), -Math.cos(yaw), 0] : [0, 0, 1];
  const r = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
  const rl = Math.hypot(r[0], r[1], r[2]);
  for (let i = 0; i < 3; i++) r[i] /= rl;
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const t = Math.tan(FOVY / 2);
  const aspect = rect.width / rect.height;
  const d = [0, 1, 2].map((k) => f[k] + nx * t * aspect * r[k] + ny * t * u[k]);
  const A2 = WGS84_A * WGS84_A;
  const B2 = WGS84_B * WGS84_B;
  const qa = (d[0] * d[0] + d[1] * d[1]) / A2 + (d[2] * d[2]) / B2;
  const qb = 2 * ((eye[0] * d[0] + eye[1] * d[1]) / A2 + (eye[2] * d[2]) / B2);
  const qc = (eye[0] * eye[0] + eye[1] * eye[1]) / A2 + (eye[2] * eye[2]) / B2 - 1;
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return null;
  const s = (-qb - Math.sqrt(disc)) / (2 * qa);
  if (s <= 0) return null;
  const g = ecefToGeodetic(eye[0] + s * d[0], eye[1] + s * d[1], eye[2] + s * d[2]);
  return [g.lon, g.lat];
}

// ---- Selection overlay: track line, present-day dot, current-age marker ----
const overlayProgram = createProgram(
  `
attribute vec3 aPos;
uniform mat4 uMVP;
uniform float uLift;
uniform float uPointSize;
void main() {
  gl_Position = uMVP * vec4(aPos * (1.0 + uLift), 1.0);
  gl_PointSize = uPointSize;
}
`,
  `
precision mediump float;
uniform vec4 uColor;
uniform float uRound;
void main() {
  if (uRound > 0.5) {
    vec2 d = gl_PointCoord - 0.5;
    if (dot(d, d) > 0.25) discard;
  }
  gl_FragColor = uColor;
}
`
);
const oPos = gl.getAttribLocation(overlayProgram, "aPos");
const oMVP = gl.getUniformLocation(overlayProgram, "uMVP");
const oLift = gl.getUniformLocation(overlayProgram, "uLift");
const oPointSize = gl.getUniformLocation(overlayProgram, "uPointSize");
const oColor = gl.getUniformLocation(overlayProgram, "uColor");
const oRound = gl.getUniformLocation(overlayProgram, "uRound");
const trackBuf = gl.createBuffer()!;
const markerBuf = gl.createBuffer()!;
let trackSegments: [number, number][] = [];

/** Surface point (ellipsoid) for a GPlates-sphere unit vector. */
function surfacePoint(u: ArrayLike<number>, out: Float32Array, o: number) {
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * u[2] * u[2]);
  out[o] = N * u[0];
  out[o + 1] = N * u[1];
  out[o + 2] = N * (1 - WGS84_E2) * u[2];
}

function uploadTrack() {
  trackSegments = [];
  if (!selection) return;
  const pts = new Float32Array(selection.track.length * 3);
  let n = 0;
  let segStart = -1;
  for (const t of selection.track) {
    if (t.unit) {
      if (segStart < 0) segStart = n;
      surfacePoint(t.unit, pts, n * 3);
      n++;
    } else if (segStart >= 0) {
      trackSegments.push([segStart, n - segStart]);
      segStart = -1;
    }
  }
  if (segStart >= 0) trackSegments.push([segStart, n - segStart]);
  gl!.bindBuffer(gl!.ARRAY_BUFFER, trackBuf);
  gl!.bufferData(gl!.ARRAY_BUFFER, pts.subarray(0, n * 3), gl!.STATIC_DRAW);
}

function drawSelection(mvp: Mat4) {
  if (!selection || !rotationTree) return;
  const g = gl!;
  g.useProgram(overlayProgram);
  // Marker ring + fill share a depth: LEQUAL lets the fill draw over the ring.
  g.depthFunc(g.LEQUAL);
  g.disableVertexAttribArray(aNormal);
  g.uniformMatrix4fv(oMVP, false, mvp);
  // Lift above the land (which floats up to ~600 m on coarse LODs) proportionally
  // to the view distance, so it stays on top without visible parallax.
  g.uniform1f(oLift, Math.min(40_000, Math.max(30, height * 0.004)) / WGS84_A);
  g.enableVertexAttribArray(oPos);

  if (trackSegments.length) {
    g.bindBuffer(g.ARRAY_BUFFER, trackBuf);
    g.vertexAttribPointer(oPos, 3, g.FLOAT, false, 0, 0);
    g.uniform4f(oColor, 1.0, 0.84, 0.25, 1.0);
    g.uniform1f(oRound, 1);
    g.uniform1f(oPointSize, 3);
    for (const [start, count] of trackSegments) {
      if (count > 1) g.drawArrays(g.LINE_STRIP, start, count);
      else g.drawArrays(g.POINTS, start, count);
    }
  }

  const now = positionAt(rotationTree, selection, selection.unit0, currentAge);
  const mk = new Float32Array(6);
  surfacePoint(selection.unit0, mk, 0);
  if (now) surfacePoint(now, mk, 3);
  g.bindBuffer(g.ARRAY_BUFFER, markerBuf);
  g.bufferData(g.ARRAY_BUFFER, mk, g.DYNAMIC_DRAW);
  g.vertexAttribPointer(oPos, 3, g.FLOAT, false, 0, 0);
  g.uniform1f(oRound, 1);
  // Present-day position: small white dot (where the track starts).
  g.uniform4f(oColor, 1, 1, 1, 1);
  g.uniform1f(oPointSize, 7);
  g.drawArrays(g.POINTS, 0, 1);
  if (now) {
    // Position at the shown age: white-ringed red marker.
    g.uniform1f(oPointSize, 15);
    g.drawArrays(g.POINTS, 1, 1);
    g.uniform4f(oColor, 1.0, 0.35, 0.31, 1);
    g.uniform1f(oPointSize, 10);
    g.drawArrays(g.POINTS, 1, 1);
  }
  g.disableVertexAttribArray(oPos);
  g.depthFunc(g.LESS);
  g.useProgram(program);
}

void loadRotationModel();
let landLoadTimer = 0;
let lastLoadLon = NaN;
let lastLoadLat = NaN;
let lastLoadH = NaN;
let lastLoadFile = "";
let lastQueuedLon = NaN;
let lastQueuedLat = NaN;
let lastQueuedH = NaN;
let baseReady = false;
let worldLoadStarted = false;
let landDisposed = false;

function resultStatus(prefix: string, result: { file: string; count: number; mesh: LandMesh; stats?: LandMesh["stats"] }): string {
  const st = result.stats;
  const fail = st ? st.earcutEmpty + st.earcutThrow : 0;
  return (
    `${prefix}${result.file} · ${result.count} feats · ${result.mesh.triangleCount} tris` +
    (fail ? ` · fail ${fail}` : "") +
    (st ? ` · maxEdge ${Math.round(st.maxEdgeMObserved)}m` : "")
  );
}

async function ensureWorld() {
  if (landDisposed || baseReady || worldLoadStarted) return;
  worldLoadStarted = true;
  setLandProgress(0, "Starting…", true);
  landStatus = "loading…";
  const result = await landLoader.loadWorld();
  if (landDisposed) return;
  if (!result) {
    worldLoadStarted = false;
    landStatus = "API offline (run npm run server)";
    setLandProgress(0, "API offline — run npm run server", true);
    return;
  }
  // The plate-tagged world may already have arrived; never replace it with the untagged one.
  const platesFirst = basePlates?.tagged ?? false;
  if (!platesFirst) setBasePlates(result.mesh);
  baseReady = true;
  lastLoadFile = WORLD_FILE;
  landStatus = resultStatus("world ", (platesFirst && plateWorldLoader.getWorld()) || result);
  setLandProgress(100, landStatus, true);
}

function clearDetail() {
  landLoader.cancelView();
  landLoader.evictDetail();
  clearSlot(detailSlot);
  detailClip = null;
  detailPlates = null;
  loadedPast = null;
  loadedViewBBox = null;
  lastLoadFile = WORLD_FILE;
  lastLoadLon = NaN;
  lastLoadLat = NaN;
  lastLoadH = NaN;
  lastQueuedLon = NaN;
  lastQueuedLat = NaN;
  lastQueuedH = NaN;
  if (baseReady) {
    const world = plateWorldLoader.getWorld() ?? landLoader.getWorld();
    landStatus = world ? resultStatus("world ", world) : "world";
  }
}

function scheduleLandLoad(lon: number, lat: number, h: number) {
  if (landDisposed) return;
  void ensureWorld();
  const file = lodFileFromHeight(h);
  // In the past each plate has moved: detail comes from the plate-tagged twin of
  // the LOD, per plate, and only while the timeline is paused.
  if (currentAge > 0) {
    const twin = plateFiles[file];
    if (file === WORLD_FILE || !twin || timeline.isPlaying || !baseReady) {
      window.clearTimeout(landLoadTimer);
      if (detailSlot.indexCount > 0 || lastLoadFile !== WORLD_FILE) clearDetail();
      return;
    }
    if (lastLoadFile !== file && detailSlot.indexCount > 0) clearDetail();
    schedulePastLoad(lon, lat, h, file, twin);
    return;
  }
  if (file === WORLD_FILE) {
    window.clearTimeout(landLoadTimer);
    if (detailSlot.indexCount > 0 || lastLoadFile !== WORLD_FILE) clearDetail();
    return;
  }
  if (!baseReady) return;

  // Reload before any visible ground (+5%) leaves the loaded detail box; loads
  // request a larger padded box so small pans and zoom-ins need no refetch.
  const halfAngle = viewHalfAngle(FOVY, canvas.width / Math.max(canvas.height, 1));
  const visible = viewBBox(lon, lat, h, halfAngle, 1.05);
  const moved =
    Number.isNaN(lastLoadLon) ||
    file !== lastLoadFile ||
    !loadedViewBBox ||
    !bboxContains(loadedViewBBox, visible, 0);
  if (!moved && detailSlot.indexCount > 0) return;

  if (lon === lastQueuedLon && lat === lastQueuedLat && h === lastQueuedH) return;

  lastQueuedLon = lon;
  lastQueuedLat = lat;
  lastQueuedH = h;

  window.clearTimeout(landLoadTimer);
  landLoadTimer = window.setTimeout(async () => {
    if (landDisposed || lodFileFromHeight(height) === WORLD_FILE) return;
    lastLoadLon = lon;
    lastLoadLat = lat;
    lastLoadH = h;
    setLandProgress(0, "Starting…", true);
    landStatus = "loading…";
    const result = await landLoader.loadView(lon, lat, h, halfAngle);
    if (landDisposed || lodFileFromHeight(height) === WORLD_FILE) return;
    if (!result || result.file !== file) return;
    setLandProgress(98, "Uploading GPU buffers…", true);
    uploadSlot(detailSlot, result.mesh);
    loadedViewBBox = result.bbox;
    // Base is hidden exactly where the detail data is complete (no overlap band).
    detailClip = { kind: "bbox", bbox: result.bbox };
    lastLoadFile = result.file;
    landStatus = resultStatus("", result);
    setLandProgress(100, landStatus, true);
  }, 180);
}

function disposeLand() {
  if (landDisposed) return;
  landDisposed = true;
  window.clearTimeout(landLoadTimer);
  landLoader.dispose();
  plateWorldLoader.dispose();
  destroySlot(detailSlot);
  destroySlot(baseSlot);
  detailClip = null;
  loadedViewBBox = null;
  baseReady = false;
}

function updateCoords(surface: number[], eye: number[]) {
  const g = ecefToGeodetic(surface[0], surface[1], surface[2]);
  coordsEl.innerHTML =
    `<div><b>Look-at (WGS84 / EPSG:4326)</b></div>` +
    `<div>lat ${fmt(g.lat, 6)}° · lon ${fmt(g.lon, 6)}°</div>` +
    `<div>ECEF ${fmt(surface[0], 1)}, ${fmt(surface[1], 1)}, ${fmt(surface[2], 1)} m</div>` +
    `<div>camera height ${fmt(height, 1)} m</div>` +
    `<div>lod ${currentAge > 0 && timeline.isPlaying ? WORLD_FILE : lodFileFromHeight(height)}</div>` +
    `<div>age ${currentAge.toFixed(0)} Ma</div>` +
    `<div>land ${landStatus}</div>`;
  scheduleLandLoad(g.lon, g.lat, height);
}

function drawMesh(
  pos: WebGLBuffer,
  nrm: WebGLBuffer,
  idx: WebGLBuffer,
  indexCount: number,
  indexType: number,
  color: [number, number, number],
  mvp: Mat4,
  model: Mat4,
  eye: number[],
  clip: LandClip | null = null
) {
  gl!.bindBuffer(gl!.ARRAY_BUFFER, pos);
  gl!.enableVertexAttribArray(aPosition);
  gl!.vertexAttribPointer(aPosition, 3, gl!.FLOAT, false, 0, 0);

  gl!.bindBuffer(gl!.ARRAY_BUFFER, nrm);
  gl!.enableVertexAttribArray(aNormal);
  gl!.vertexAttribPointer(aNormal, 3, gl!.FLOAT, false, 0, 0);

  gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, idx);
  gl!.uniformMatrix4fv(uMVP, false, mvp);
  gl!.uniformMatrix4fv(uModel, false, model);
  gl!.uniform3f(uCameraPos, eye[0], eye[1], eye[2]);
  gl!.uniform3f(uBaseColor, color[0], color[1], color[2]);
  if (clip?.kind === "bbox") {
    gl!.uniform1f(uClipLand, 1);
    gl!.uniform4f(uClipBBox, clip.bbox.west, clip.bbox.south, clip.bbox.east, clip.bbox.north);
  } else if (clip?.kind === "cap") {
    gl!.uniform1f(uClipLand, 2);
    gl!.uniform4f(uClipCap, clip.center[0], clip.center[1], clip.center[2], clip.cosR);
  } else {
    gl!.uniform1f(uClipLand, 0);
  }
  gl!.drawElements(gl!.TRIANGLES, indexCount, indexType, 0);
}

let lastFrameMs = performance.now();

function frame() {
  const nowMs = performance.now();
  timeline.tick((nowMs - lastFrameMs) / 1000);
  lastFrameMs = nowMs;
  applyAge();
  resize();
  const eye = cameraPos();
  const surface = lookAtSurfacePoint();
  updateCoords(surface, eye);

  const aspect = canvas.width / canvas.height;
  const near = Math.max(1, height * 0.05);
  const far = height + WGS84_A * 4;
  const proj = mat4Perspective(FOVY, aspect, near, far);

  const up: number[] = Math.abs(pitch) > 1.2 ? [-Math.sin(yaw), -Math.cos(yaw), 0] : [0, 0, 1];
  const view = mat4LookAt(eye, [0, 0, 0], up);
  const model = mat4Identity();
  const mvp = mat4Multiply(proj, mat4Multiply(view, model));

  gl!.clearColor(0.04, 0.06, 0.09, 1);
  gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT);
  gl!.enable(gl!.DEPTH_TEST);
  gl!.enable(gl!.CULL_FACE);
  gl!.cullFace(gl!.BACK);
  gl!.useProgram(program);

  // Ocean ellipsoid
  drawMesh(
    posBuf,
    nrmBuf,
    idxBuf,
    ellipsoid.indices.length,
    gl!.UNSIGNED_SHORT,
    [0.25, 0.55, 0.95],
    mvp,
    model,
    eye
  );

  gl!.enable(gl!.CULL_FACE);
  gl!.frontFace(gl!.CCW);
  gl!.cullFace(gl!.BACK);
  if (baseSlot.indexCount > 0) {
    const clip = detailSlot.indexCount > 0 ? detailClip : null;
    drawMesh(
      baseSlot.pos,
      baseSlot.nrm,
      baseSlot.idx,
      baseSlot.indexCount,
      gl!.UNSIGNED_INT,
      [0.28, 0.62, 0.32],
      mvp,
      model,
      eye,
      clip
    );
  }
  if (detailSlot.indexCount > 0) {
    gl!.enable(gl!.POLYGON_OFFSET_FILL);
    gl!.polygonOffset(-1, -1);
    drawMesh(
      detailSlot.pos,
      detailSlot.nrm,
      detailSlot.idx,
      detailSlot.indexCount,
      gl!.UNSIGNED_INT,
      [0.28, 0.62, 0.32],
      mvp,
      model,
      eye
    );
    gl!.disable(gl!.POLYGON_OFFSET_FILL);
  }

  drawSelection(mvp);

  requestAnimationFrame(frame);
}

window.addEventListener("pagehide", (e) => {
  if (!e.persisted) disposeLand();
});
requestAnimationFrame(frame);
