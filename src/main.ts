const canvas = document.getElementById("gl") as HTMLCanvasElement;
const coordsEl = document.getElementById("coords") as HTMLDivElement;
const gl = canvas.getContext("webgl");
if (!gl) throw new Error("WebGL not supported");

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

void main() {
  vec3 n = normalize(vNormal);
  vec3 l = normalize(uLightPos - vWorldPos);
  vec3 v = normalize(uCameraPos - vWorldPos);
  vec3 h = normalize(l + v);

  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(n, h), 0.0), 32.0);
  float ambient = 0.18;

  vec3 base = vec3(0.25, 0.55, 0.95);
  vec3 color = base * (ambient + diff * 0.85) + vec3(1.0) * spec * 0.35;
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

      // theta=0 at +Z (north pole)
      const x = WGS84_A * sinT * cosP;
      const y = WGS84_A * sinT * sinP;
      const z = WGS84_B * cosT;

      positions.push(x, y, z);

      // Ellipsoid surface normal ∝ (x/a², y/a², z/b²)
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

/** Geocentric radius of WGS84 surface in unit direction (dx,dy,dz). */
function ellipsoidRadius(dx: number, dy: number, dz: number): number {
  const len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  return 1 / Math.sqrt((ux * ux + uy * uy) / (WGS84_A * WGS84_A) + (uz * uz) / (WGS84_B * WGS84_B));
}

/** ECEF (Z-up) → geodetic lat/lon (deg) and ellipsoidal height (m). */
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

const aPosition = gl.getAttribLocation(program, "aPosition");
const aNormal = gl.getAttribLocation(program, "aNormal");
const uMVP = gl.getUniformLocation(program, "uMVP");
const uModel = gl.getUniformLocation(program, "uModel");
const uLightPos = gl.getUniformLocation(program, "uLightPos");
const uCameraPos = gl.getUniformLocation(program, "uCameraPos");

// --- GeoJSON overlay (EPSG:4326 → WGS84 ECEF) ---

const geoVsSource = `
attribute vec3 aPosition;
uniform mat4 uMVP;
void main() {
  gl_Position = uMVP * vec4(aPosition, 1.0);
  gl_PointSize = 8.0;
}
`;

const geoFsSource = `
precision mediump float;
uniform vec4 uColor;
void main() {
  gl_FragColor = uColor;
}
`;

const geoProgram = createProgram(geoVsSource, geoFsSource);
const geoAPosition = gl.getAttribLocation(geoProgram, "aPosition");
const geoUMVP = gl.getUniformLocation(geoProgram, "uMVP");
const geoUColor = gl.getUniformLocation(geoProgram, "uColor");

/** Geodetic lon/lat (deg, EPSG:4326) → ECEF on WGS84 surface (+ small offset). */
function geodeticToEcef(lonDeg: number, latDeg: number, h = 2000): number[] {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const x = (N + h) * cosLat * cosLon;
  const y = (N + h) * cosLat * sinLon;
  const z = (N * (1 - WGS84_E2) + h) * sinLat;
  return [x, y, z];
}

type GeoBuffers = {
  linePositions: Float32Array;
  lineCount: number;
  pointPositions: Float32Array;
  pointCount: number;
  polyPositions: Float32Array;
  polyCount: number;
};

const emptyGeo: GeoBuffers = {
  linePositions: new Float32Array(0),
  lineCount: 0,
  pointPositions: new Float32Array(0),
  pointCount: 0,
  polyPositions: new Float32Array(0),
  polyCount: 0,
};

let geoData: GeoBuffers = emptyGeo;
const geoLineBuf = gl.createBuffer()!;
const geoPointBuf = gl.createBuffer()!;
const geoPolyBuf = gl.createBuffer()!;

function densifyRing(coords: number[][], maxStepDeg = 2): number[][] {
  if (coords.length < 2) return coords;
  const out: number[][] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const [lon0, lat0] = coords[i];
    const [lon1, lat1] = coords[i + 1];
    const dLon = lon1 - lon0;
    const dLat = lat1 - lat0;
    const steps = Math.max(1, Math.ceil(Math.hypot(dLon, dLat) / maxStepDeg));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push([lon0 + dLon * t, lat0 + dLat * t]);
    }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

function pushEcefLine(target: number[], coords: number[][]) {
  const dense = densifyRing(coords);
  for (let i = 0; i < dense.length - 1; i++) {
    const a = geodeticToEcef(dense[i][0], dense[i][1]);
    const b = geodeticToEcef(dense[i + 1][0], dense[i + 1][1]);
    target.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
}

function earClipPolygon(ring: number[][]): number[] {
  // Project lon/lat to a local 2D plane for triangulation (small regions)
  if (ring.length < 3) return [];
  const pts = densifyRing(ring, 1);
  // Drop closing duplicate if present
  if (
    pts.length > 1 &&
    pts[0][0] === pts[pts.length - 1][0] &&
    pts[0][1] === pts[pts.length - 1][1]
  ) {
    pts.pop();
  }
  if (pts.length < 3) return [];

  const n0 = pts.length;
  const idx = Array.from({ length: n0 }, (_, i) => i);
  const area2 = () => {
    let a = 0;
    for (let i = 0; i < idx.length; i++) {
      const j = (i + 1) % idx.length;
      const [x0, y0] = pts[idx[i]];
      const [x1, y1] = pts[idx[j]];
      a += x0 * y1 - x1 * y0;
    }
    return a;
  };
  if (area2() < 0) idx.reverse();

  const tris: number[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n0 * n0) {
    let ear = -1;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length];
      const i1 = idx[i];
      const i2 = idx[(i + 1) % idx.length];
      const [ax, ay] = pts[i0];
      const [bx, by] = pts[i1];
      const [cx, cy] = pts[i2];
      const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (cross <= 0) continue;
      let inside = false;
      for (let k = 0; k < idx.length; k++) {
        const pi = idx[k];
        if (pi === i0 || pi === i1 || pi === i2) continue;
        const [px, py] = pts[pi];
        const c1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        const c2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
        const c3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
        if (c1 >= 0 && c2 >= 0 && c3 >= 0) {
          inside = true;
          break;
        }
      }
      if (!inside) {
        ear = i;
        break;
      }
    }
    if (ear < 0) break;
    const i0 = idx[(ear + idx.length - 1) % idx.length];
    const i1 = idx[ear];
    const i2 = idx[(ear + 1) % idx.length];
    const a = geodeticToEcef(pts[i0][0], pts[i0][1]);
    const b = geodeticToEcef(pts[i1][0], pts[i1][1]);
    const c = geodeticToEcef(pts[i2][0], pts[i2][1]);
    tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    idx.splice(ear, 1);
  }
  if (idx.length === 3) {
    const a = geodeticToEcef(pts[idx[0]][0], pts[idx[0]][1]);
    const b = geodeticToEcef(pts[idx[1]][0], pts[idx[1]][1]);
    const c = geodeticToEcef(pts[idx[2]][0], pts[idx[2]][1]);
    tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
  return tris;
}

function parseGeoJSON(gj: any): GeoBuffers {
  const lines: number[] = [];
  const points: number[] = [];
  const polys: number[] = [];

  const features =
    gj?.type === "FeatureCollection"
      ? gj.features || []
      : gj?.type === "Feature"
        ? [gj]
        : gj?.type
          ? [{ type: "Feature", geometry: gj }]
          : [];

  function handleGeometry(geom: any) {
    if (!geom) return;
    const t = geom.type;
    const c = geom.coordinates;
    if (t === "Point") {
      const p = geodeticToEcef(c[0], c[1]);
      points.push(p[0], p[1], p[2]);
    } else if (t === "MultiPoint") {
      for (const pt of c) {
        const p = geodeticToEcef(pt[0], pt[1]);
        points.push(p[0], p[1], p[2]);
      }
    } else if (t === "LineString") {
      pushEcefLine(lines, c);
    } else if (t === "MultiLineString") {
      for (const line of c) pushEcefLine(lines, line);
    } else if (t === "Polygon") {
      // Exterior ring outline + fill; skip holes for simplicity
      if (c[0]) {
        pushEcefLine(lines, c[0]);
        polys.push(...earClipPolygon(c[0]));
      }
    } else if (t === "MultiPolygon") {
      for (const poly of c) {
        if (poly[0]) {
          pushEcefLine(lines, poly[0]);
          polys.push(...earClipPolygon(poly[0]));
        }
      }
    } else if (t === "GeometryCollection") {
      for (const g of geom.geometries || []) handleGeometry(g);
    }
  }

  for (const f of features) handleGeometry(f.geometry);

  return {
    linePositions: new Float32Array(lines),
    lineCount: lines.length / 3,
    pointPositions: new Float32Array(points),
    pointCount: points.length / 3,
    polyPositions: new Float32Array(polys),
    polyCount: polys.length / 3,
  };
}

function uploadGeo(data: GeoBuffers) {
  geoData = data;
  gl!.bindBuffer(gl!.ARRAY_BUFFER, geoLineBuf);
  gl!.bufferData(gl!.ARRAY_BUFFER, data.linePositions, gl!.STATIC_DRAW);
  gl!.bindBuffer(gl!.ARRAY_BUFFER, geoPointBuf);
  gl!.bufferData(gl!.ARRAY_BUFFER, data.pointPositions, gl!.STATIC_DRAW);
  gl!.bindBuffer(gl!.ARRAY_BUFFER, geoPolyBuf);
  gl!.bufferData(gl!.ARRAY_BUFFER, data.polyPositions, gl!.STATIC_DRAW);
}

/** Simple key=value .conf parser (ignores # comments and blank lines). */
function parseConf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    out[key] = val;
  }
  return out;
}

async function loadGeoFromConf() {
  try {
    const confRes = await fetch("/globe.conf");
    if (!confRes.ok) {
      console.warn("globe.conf not found");
      return;
    }
    const conf = parseConf(await confRes.text());
    const path = conf["geojson_path"];
    if (!path) {
      console.info("geojson_path empty in globe.conf — no overlay");
      return;
    }
    const url = path.startsWith("/") || path.startsWith("http") ? path : `/${path}`;
    const gjRes = await fetch(url);
    if (!gjRes.ok) throw new Error(`Failed to load GeoJSON: ${url} (${gjRes.status})`);
    const gj = await gjRes.json();
    uploadGeo(parseGeoJSON(gj));
    console.info(
      `Loaded GeoJSON ${url}: ${geoData.lineCount} line verts, ${geoData.pointCount} points, ${geoData.polyCount} poly verts`
    );
  } catch (e) {
    console.error("GeoJSON load failed:", e);
  }
}

loadGeoFromConf();

function drawGeo(mvp: Mat4) {
  if (!geoData.lineCount && !geoData.pointCount && !geoData.polyCount) return;

  gl!.useProgram(geoProgram);
  gl!.uniformMatrix4fv(geoUMVP, false, mvp);
  gl!.enable(gl!.BLEND);
  gl!.blendFunc(gl!.SRC_ALPHA, gl!.ONE_MINUS_SRC_ALPHA);
  gl!.depthMask(false);

  if (geoData.polyCount > 0) {
    gl!.uniform4f(geoUColor, 0.2, 0.9, 0.45, 0.35);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, geoPolyBuf);
    gl!.enableVertexAttribArray(geoAPosition);
    gl!.vertexAttribPointer(geoAPosition, 3, gl!.FLOAT, false, 0, 0);
    gl!.drawArrays(gl!.TRIANGLES, 0, geoData.polyCount);
  }

  if (geoData.lineCount > 0) {
    gl!.uniform4f(geoUColor, 1.0, 0.85, 0.2, 0.95);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, geoLineBuf);
    gl!.enableVertexAttribArray(geoAPosition);
    gl!.vertexAttribPointer(geoAPosition, 3, gl!.FLOAT, false, 0, 0);
    gl!.drawArrays(gl!.LINES, 0, geoData.lineCount);
  }

  if (geoData.pointCount > 0) {
    gl!.uniform4f(geoUColor, 1.0, 0.35, 0.25, 1.0);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, geoPointBuf);
    gl!.enableVertexAttribArray(geoAPosition);
    gl!.vertexAttribPointer(geoAPosition, 3, gl!.FLOAT, false, 0, 0);
    gl!.drawArrays(gl!.POINTS, 0, geoData.pointCount);
  }

  gl!.depthMask(true);
  gl!.disable(gl!.BLEND);
}

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

/** Radians of orbit per screen pixel — scales with height so drag tracks the surface. */
function orbitRadiansPerPixel(): number {
  const h = Math.max(canvas.clientHeight, 1);
  const metersPerPixel = (2 * height * Math.tan(FOVY / 2)) / h;
  const [dx, dy, dz] = viewDir();
  const R = ellipsoidRadius(dx, dy, dz);
  return metersPerPixel / R;
}

/** Zoom exp gain: stronger far out, gentler near the surface. */
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

/** Unit direction from earth center toward camera (Z = north). */
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

/** Surface point the camera looks at (ray toward origin ∩ ellipsoid). */
function lookAtSurfacePoint(): number[] {
  const [dx, dy, dz] = viewDir();
  const R = ellipsoidRadius(dx, dy, dz);
  return [dx * R, dy * R, dz * R];
}

function fmt(n: number, digits: number): string {
  return n.toFixed(digits);
}

function updateCoords(surface: number[], eye: number[]) {
  const g = ecefToGeodetic(surface[0], surface[1], surface[2]);
  const camH = height;
  coordsEl.innerHTML =
    `<div><b>Look-at (WGS84 surface)</b></div>` +
    `<div>lat ${fmt(g.lat, 6)}° · lon ${fmt(g.lon, 6)}°</div>` +
    `<div>ECEF ${fmt(surface[0], 1)}, ${fmt(surface[1], 1)}, ${fmt(surface[2], 1)} m</div>` +
    `<div>camera height ${fmt(camH, 1)} m</div>` +
    `<div>camera ECEF ${fmt(eye[0], 1)}, ${fmt(eye[1], 1)}, ${fmt(eye[2], 1)} m</div>`;
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

  // Stable up near poles: blend world Z with a yaw-based tangent
  const up: number[] = Math.abs(pitch) > 1.2 ? [-Math.sin(yaw), -Math.cos(yaw), 0] : [0, 0, 1];
  const view = mat4LookAt(eye, [0, 0, 0], up);
  const model = mat4Identity();
  const mvp = mat4Multiply(proj, mat4Multiply(view, model));

  gl!.clearColor(0.04, 0.06, 0.09, 1);
  gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT);
  gl!.enable(gl!.DEPTH_TEST);
  gl!.useProgram(program);

  gl!.bindBuffer(gl!.ARRAY_BUFFER, posBuf);
  gl!.enableVertexAttribArray(aPosition);
  gl!.vertexAttribPointer(aPosition, 3, gl!.FLOAT, false, 0, 0);

  gl!.bindBuffer(gl!.ARRAY_BUFFER, nrmBuf);
  gl!.enableVertexAttribArray(aNormal);
  gl!.vertexAttribPointer(aNormal, 3, gl!.FLOAT, false, 0, 0);

  gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl!.uniformMatrix4fv(uMVP, false, mvp);
  gl!.uniformMatrix4fv(uModel, false, model);
  gl!.uniform3f(uLightPos, WGS84_A * 2, WGS84_A * 1.5, WGS84_A * 3);
  gl!.uniform3f(uCameraPos, eye[0], eye[1], eye[2]);

  gl!.drawElements(gl!.TRIANGLES, ellipsoid.indices.length, gl!.UNSIGNED_SHORT, 0);
  drawGeo(mvp);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
