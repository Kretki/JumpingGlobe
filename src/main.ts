import { LandLoader } from "./land/loader";
import type { LandMesh } from "./land/mesh";

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
precision mediump float;
varying vec3 vNormal;
varying vec3 vWorldPos;
uniform vec3 uLightPos;
uniform vec3 uCameraPos;
uniform vec3 uBaseColor;

void main() {
  vec3 n = normalize(vNormal);
  vec3 l = normalize(uLightPos - vWorldPos);
  vec3 v = normalize(uCameraPos - vWorldPos);
  vec3 h = normalize(l + v);

  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(n, h), 0.0), 32.0);
  float ambient = 0.18;

  vec3 color = uBaseColor * (ambient + diff * 0.85) + vec3(1.0) * spec * 0.25;
  gl_FragColor = vec4(color, 1.0);
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

const landPosBuf = gl.createBuffer()!;
const landNrmBuf = gl.createBuffer()!;
const landIdxBuf = gl.createBuffer()!;
let landIndexCount = 0;
let landLod = -1;
let landFeatureCount = 0;

function uploadLandMesh(mesh: LandMesh) {
  gl!.bindBuffer(gl!.ARRAY_BUFFER, landPosBuf);
  gl!.bufferData(gl!.ARRAY_BUFFER, mesh.positions, gl!.STATIC_DRAW);
  gl!.bindBuffer(gl!.ARRAY_BUFFER, landNrmBuf);
  gl!.bufferData(gl!.ARRAY_BUFFER, mesh.normals, gl!.STATIC_DRAW);
  gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, landIdxBuf);
  gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, mesh.indices, gl!.STATIC_DRAW);
  landIndexCount = mesh.indices.length;
  landFeatureCount = mesh.featureCount;
}

const aPosition = gl.getAttribLocation(program, "aPosition");
const aNormal = gl.getAttribLocation(program, "aNormal");
const uMVP = gl.getUniformLocation(program, "uMVP");
const uModel = gl.getUniformLocation(program, "uModel");
const uLightPos = gl.getUniformLocation(program, "uLightPos");
const uCameraPos = gl.getUniformLocation(program, "uCameraPos");
const uBaseColor = gl.getUniformLocation(program, "uBaseColor");

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
  yaw -= dx * k;
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
let landLoadTimer = 0;
let lastLoadLon = NaN;
let lastLoadLat = NaN;
let lastLoadH = NaN;

function scheduleLandLoad(lon: number, lat: number, h: number) {
  const moved =
    Math.abs(lon - lastLoadLon) > 1.5 ||
    Math.abs(lat - lastLoadLat) > 1.5 ||
    Math.abs(Math.log(h) - Math.log(lastLoadH || h)) > 0.15 ||
    Number.isNaN(lastLoadLon);
  if (!moved && landIndexCount > 0) return;

  window.clearTimeout(landLoadTimer);
  landLoadTimer = window.setTimeout(async () => {
    lastLoadLon = lon;
    lastLoadLat = lat;
    lastLoadH = h;
    setLandProgress(0, "Starting…", true);
    landStatus = "loading…";
    const result = await landLoader.loadForView(lon, lat, h);
    if (!result) {
      if (landIndexCount === 0) {
        landStatus = "API offline (run npm run server)";
        setLandProgress(0, "API offline — run npm run server", true);
      }
      return;
    }
    setLandProgress(98, "Uploading GPU buffers…", true);
    uploadLandMesh(result.mesh);
    landLod = result.lod;
    const st = result.stats;
    const fail = st ? st.earcutEmpty + st.earcutThrow : 0;
    landStatus =
      `lod${result.lod} · ${result.count} feats · ${result.mesh.triangleCount} tris` +
      (fail ? ` · fail ${fail}` : "") +
      (st ? ` · maxEdge ${Math.round(st.maxEdgeMObserved)}m` : "");
    setLandProgress(100, landStatus, true);
  }, 180);
}

function updateCoords(surface: number[], eye: number[]) {
  const g = ecefToGeodetic(surface[0], surface[1], surface[2]);
  coordsEl.innerHTML =
    `<div><b>Look-at (WGS84 / EPSG:4326)</b></div>` +
    `<div>lat ${fmt(g.lat, 6)}° · lon ${fmt(g.lon, 6)}°</div>` +
    `<div>ECEF ${fmt(surface[0], 1)}, ${fmt(surface[1], 1)}, ${fmt(surface[2], 1)} m</div>` +
    `<div>camera height ${fmt(height, 1)} m</div>` +
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
  eye: number[]
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
  gl!.uniform3f(uLightPos, WGS84_A * 2, WGS84_A * 1.5, WGS84_A * 3);
  gl!.uniform3f(uCameraPos, eye[0], eye[1], eye[2]);
  gl!.uniform3f(uBaseColor, color[0], color[1], color[2]);
  gl!.drawElements(gl!.TRIANGLES, indexCount, indexType, 0);
}

function frame() {
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

  // Land polygons (EPSG:4326 → ECEF); windings forced outward in mesh pipeline
  if (landIndexCount > 0) {
    gl!.enable(gl!.CULL_FACE);
    gl!.frontFace(gl!.CCW);
    gl!.cullFace(gl!.BACK);
    drawMesh(
      landPosBuf,
      landNrmBuf,
      landIdxBuf,
      landIndexCount,
      gl!.UNSIGNED_INT,
      [0.28, 0.62, 0.32],
      mvp,
      model,
      eye
    );
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
