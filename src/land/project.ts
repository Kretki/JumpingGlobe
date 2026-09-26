/** EPSG:4326 (lon/lat degrees, h meters) → ECEF on WGS84 + surface-aware helpers. */

export type Vec3 = [number, number, number];
export type LonLat = [number, number];

export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_B = WGS84_A * (1 - WGS84_F);
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/** Radial offset after geometry is constrained. Z-fight only. */
export const LAND_HEIGHT_M = 12;

/** Max ellipsoid chord after all splits. Sagitta s ≈ R α²/2 < ~10 m. */
export const MAX_EDGE_M: Record<0 | 1 | 2, number> = {
  0: 25000,
  1: 12000,
  2: 6000,
};

/** Boundary sample cap (geodesic, metres), independent of interior split. */
export const MAX_BOUNDARY_EDGE_M: Record<0 | 1 | 2, number> = {
  0: 25000,
  1: 10000,
  2: 5000,
};

export const MAX_BOUNDARY_SUBDIV = 256;
export const ANTIMERIDIAN_EPS_DEG = 1e-9;
export const POLE_LAT_DEG = 89.999;
export const ENU_MIN_EXTENT_M = 1;
export const POLAR_CHART_LAT_DEG = 75;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Geodetic lon/lat (deg) + height (m) → ECEF meters (Z = north). */
export function lonLatToEcef(lonDeg: number, latDeg: number, h = 0): Vec3 {
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

/** Unit outward normal at lon/lat on the ellipsoid. */
export function lonLatNormal(lonDeg: number, latDeg: number): Vec3 {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const nx = cosLat * cosLon;
  const ny = cosLat * sinLon;
  const nz = sinLat;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

export function ecefNormalize(x: number, y: number, z: number): Vec3 {
  const n = Math.hypot(x, y, z) || 1;
  return [x / n, y / n, z / n];
}

export function hypot3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Geocentric lon/lat from ECEF (fast; OK for direction-only uses). */
export function ecefToLonLat(x: number, y: number, z: number): LonLat {
  const lon = (Math.atan2(y, x) * 180) / Math.PI;
  const p = Math.hypot(x, y);
  const lat = (Math.atan2(z, p) * 180) / Math.PI;
  return [lon, lat];
}

/** Iterative geodetic lon/lat from ECEF (WGS84). */
export function ecefToGeodetic(x: number, y: number, z: number): LonLat {
  const lon = (Math.atan2(y, x) * 180) / Math.PI;
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  for (let i = 0; i < 8; i++) {
    const sinLat = Math.sin(lat);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    lat = Math.atan2(z + WGS84_E2 * N * sinLat, p);
  }
  return [lon, (lat * 180) / Math.PI];
}

export function normalizeLon(lon: number): number {
  let x = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (x === -180) x = 180;
  return x;
}

export function normalizeLonLat(p: LonLat): LonLat {
  return [normalizeLon(p[0]), clamp(p[1], -90, 90)];
}

export function stripClosingVertex(ring: number[][]): LonLat[] {
  if (ring.length < 2) return ring.map((p) => [p[0], p[1]] as LonLat);
  const a = ring[0];
  const b = ring[ring.length - 1];
  const out =
    a[0] === b[0] && a[1] === b[1] ? ring.slice(0, -1) : ring.slice();
  return out.map((p) => [p[0], p[1]] as LonLat);
}

/** Unwrap a ring into a continuous longitude frame (lons may exit [-180,180]). */
export function unwrapRingLons(ring: number[][]): LonLat[] {
  if (ring.length === 0) return [];
  const out: LonLat[] = [[ring[0][0], ring[0][1]]];
  for (let i = 1; i < ring.length; i++) {
    let lon = ring[i][0];
    const prev = out[i - 1][0];
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    out.push([lon, ring[i][1]]);
  }
  return out;
}

/** Lon span of an already-unwrapped ring. */
export function unwrappedLonSpan(ring: LonLat[]): number {
  if (!ring.length) return 0;
  let minL = ring[0][0];
  let maxL = ring[0][0];
  for (let i = 1; i < ring.length; i++) {
    minL = Math.min(minL, ring[i][0]);
    maxL = Math.max(maxL, ring[i][0]);
  }
  return maxL - minL;
}

function interpAtLon(
  a: LonLat,
  b: LonLat,
  targetLon: number
): LonLat {
  const dLon = b[0] - a[0];
  if (Math.abs(dLon) < ANTIMERIDIAN_EPS_DEG) return [targetLon, (a[1] + b[1]) / 2];
  const t = (targetLon - a[0]) / dLon;
  return [targetLon, a[1] + t * (b[1] - a[1])];
}

/** Clip unwrapped ring to lon half-plane [lonMin, lonMax] (Sutherland–Hodgman). */
function clipRingLon(ring: LonLat[], lonMin: number, lonMax: number): LonLat[] {
  const inside = (p: LonLat) => p[0] >= lonMin - ANTIMERIDIAN_EPS_DEG && p[0] <= lonMax + ANTIMERIDIAN_EPS_DEG;
  let output = ring.slice();
  // clip lon >= lonMin
  {
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const curIn = cur[0] >= lonMin - ANTIMERIDIAN_EPS_DEG;
      const prevIn = prev[0] >= lonMin - ANTIMERIDIAN_EPS_DEG;
      if (curIn) {
        if (!prevIn) output.push(interpAtLon(prev, cur, lonMin));
        output.push(cur);
      } else if (prevIn) {
        output.push(interpAtLon(prev, cur, lonMin));
      }
    }
  }
  // clip lon <= lonMax
  {
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const curIn = cur[0] <= lonMax + ANTIMERIDIAN_EPS_DEG;
      const prevIn = prev[0] <= lonMax + ANTIMERIDIAN_EPS_DEG;
      if (curIn) {
        if (!prevIn) output.push(interpAtLon(prev, cur, lonMax));
        output.push(cur);
      } else if (prevIn) {
        output.push(interpAtLon(prev, cur, lonMax));
      }
    }
  }
  void inside;
  return output;
}

/**
 * Split an unwrapped ring into pieces with lon span ≤ 180°.
 * Returns rings (unwrapped or rewrapped) suitable for ENU earcut.
 */
export function splitRingAntimeridian(ringIn: number[][]): LonLat[][] {
  const ring = unwrapRingLons(stripClosingVertex(ringIn));
  if (ring.length < 3) return [];

  let minL = ring[0][0];
  let maxL = ring[0][0];
  for (const p of ring) {
    minL = Math.min(minL, p[0]);
    maxL = Math.max(maxL, p[0]);
  }
  if (maxL - minL <= 180 + ANTIMERIDIAN_EPS_DEG) {
    return [ring];
  }

  const rings: LonLat[][] = [];
  // Slice into 180° windows from minL
  for (let left = minL; left < maxL - ANTIMERIDIAN_EPS_DEG; left += 180) {
    const right = left + 180;
    const clipped = clipRingLon(ring, left, right);
    const cleaned: LonLat[] = [];
    for (const p of clipped) {
      const last = cleaned[cleaned.length - 1];
      if (!last || Math.abs(last[0] - p[0]) > 1e-12 || Math.abs(last[1] - p[1]) > 1e-12) {
        cleaned.push(p);
      }
    }
    if (
      cleaned.length > 1 &&
      Math.abs(cleaned[0][0] - cleaned[cleaned.length - 1][0]) < 1e-12 &&
      Math.abs(cleaned[0][1] - cleaned[cleaned.length - 1][1]) < 1e-12
    ) {
      cleaned.pop();
    }
    if (cleaned.length >= 3) rings.push(cleaned);
  }
  return rings.length ? rings : [ring];
}

/** 2D winding number of unwrapped ring around (lon, lat). */
export function windingNumber(ring: LonLat[], lon: number, lat: number): number {
  let wn = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (a[1] <= lat) {
      if (b[1] > lat && isLeft(a, b, lon, lat) > 0) wn++;
    } else if (b[1] <= lat && isLeft(a, b, lon, lat) < 0) wn--;
  }
  return wn;
}

function isLeft(a: LonLat, b: LonLat, lon: number, lat: number): number {
  return (b[0] - a[0]) * (lat - a[1]) - (lon - a[0]) * (b[1] - a[1]);
}

export type PoleKind = "north" | "south" | null;

/** Detect pole enclosure in unwrapped frame. */
export function ringEnclosesPole(ringIn: number[][]): PoleKind {
  const ring = unwrapRingLons(stripClosingVertex(ringIn));
  if (ring.length < 3) return null;

  let minLat = 90;
  let maxLat = -90;
  let meanLon = 0;
  for (const p of ring) {
    minLat = Math.min(minLat, p[1]);
    maxLat = Math.max(maxLat, p[1]);
    meanLon += p[0];
  }
  meanLon /= ring.length;
  const span = unwrappedLonSpan(ring);

  // Full-longitude polar caps (constant-lat coasts) — span heuristic first
  if (span > 270) {
    if (maxLat > 70 && minLat > 0) return "north";
    if (minLat < -70 && maxLat < 0) return "south";
    if (maxLat > 85) return "north";
    if (minLat < -85) return "south";
  }

  // Continuous closing edge for winding (avoid ±180 jump)
  let closeLon = ring[0][0];
  const lastLon = ring[ring.length - 1][0];
  while (closeLon - lastLon > 180) closeLon -= 360;
  while (closeLon - lastLon < -180) closeLon += 360;
  const closed: LonLat[] = ring.concat([[closeLon, ring[0][1]]]);

  if (windingNumber(closed, meanLon, POLE_LAT_DEG) !== 0) return "north";
  if (windingNumber(closed, meanLon, -POLE_LAT_DEG) !== 0) return "south";
  return null;
}

/**
 * Split a pole-enclosing ring along a meridian into two non-wrapping pieces,
 * inserting vertices at ±POLE_LAT_DEG.
 */
export function splitPoleRing(ringIn: number[][], pole: "north" | "south"): LonLat[][] {
  const ring = unwrapRingLons(stripClosingVertex(ringIn));
  if (ring.length < 3) return [];
  const poleLat = pole === "north" ? POLE_LAT_DEG : -POLE_LAT_DEG;

  let minL = ring[0][0];
  let maxL = ring[0][0];
  let sumL = 0;
  for (const p of ring) {
    minL = Math.min(minL, p[0]);
    maxL = Math.max(maxL, p[0]);
    sumL += p[0];
  }
  const cutLon = sumL / ring.length; // meridian through mean

  // Insert cutLon crossings and pole stubs: build ring with pole append
  // Strategy: project to polar chart instead is preferred; here produce one ring
  // that goes to the pole along cutLon so chart is simply connected.
  // Find closest edge to cutLon and inject pole path.
  const withPole: LonLat[] = [];
  let inserted = false;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    withPole.push(a);
    const lo = Math.min(a[0], b[0]);
    const hi = Math.max(a[0], b[0]);
    if (!inserted && cutLon >= lo && cutLon <= hi && Math.abs(b[0] - a[0]) > 1e-12) {
      const mid = interpAtLon(a, b, cutLon);
      withPole.push(mid);
      withPole.push([cutLon, poleLat]);
      // slight offset so polygon doesn't zero-area collapse
      withPole.push([cutLon + 1e-6, mid[1]]);
      inserted = true;
    }
  }
  if (!inserted) {
    withPole.push([cutLon, poleLat]);
  }

  // If span still > 180, also antimeridian-split
  const unwrapped = unwrapRingLons(withPole);
  if (unwrappedLonSpan(unwrapped) > 180) {
    return splitRingAntimeridian(withPole);
  }
  return [unwrapped.map((p) => normalizeLonLat(p))];
}

/**
 * Point at fraction t along the surface path from p0 to p1.
 * Uses geodetic lon/lat interpolation (short-arc unwrap) then lonLatToEcef
 * so the result lies on the same ellipsoid + height as the rest of the mesh.
 */
export function geodesicPoint(p0: Vec3, p1: Vec3, t: number, h = LAND_HEIGHT_M): Vec3 {
  if (t <= 0) return lonLatToEcef(...ecefToGeodetic(p0[0], p0[1], p0[2]), h);
  if (t >= 1) return lonLatToEcef(...ecefToGeodetic(p1[0], p1[1], p1[2]), h);
  const [lon0, lat0] = ecefToGeodetic(p0[0], p0[1], p0[2]);
  const [lon1, lat1] = ecefToGeodetic(p1[0], p1[1], p1[2]);
  let dLon = lon1 - lon0;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  const lon = lon0 + t * dLon;
  const lat = lat0 + t * (lat1 - lat0);
  return lonLatToEcef(lon, lat, h);
}

/** Lon/lat geodesic-ish interpolate in an already-unwrapped frame. */
export function interpolateLonLat(a: LonLat, b: LonLat, t: number): LonLat {
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

function keepLonContinuous(lon: number, prevLon: number): number {
  let x = lon;
  while (x - prevLon > 180) x -= 360;
  while (x - prevLon < -180) x += 360;
  return x;
}

/**
 * Densify ring so every consecutive ECEF chord is ≤ maxEdgeM.
 * Subdivides by lon/lat midpoint recursion in the unwrapped frame.
 */
export function densifyRingGeodesic(
  ringLonLat: number[][],
  maxEdgeM: number,
  h = LAND_HEIGHT_M
): LonLat[] {
  const unwrapped = unwrapRingLons(stripClosingVertex(ringLonLat));
  if (unwrapped.length < 2) return unwrapped;
  const out: LonLat[] = [];
  const n = unwrapped.length;
  const budget = Math.max(maxEdgeM, 1);

  const subdivide = (a: LonLat, b: LonLat, depth: number) => {
    const pa = lonLatToEcef(a[0], a[1], h);
    const pb = lonLatToEcef(b[0], b[1], h);
    const dist = hypot3(pa, pb);
    if (dist <= budget || depth >= 14) return;
    const mid = interpolateLonLat(a, b, 0.5);
    subdivide(a, mid, depth + 1);
    out.push(mid);
    subdivide(mid, b, depth + 1);
  };

  for (let i = 0; i < n; i++) {
    const a = unwrapped[i];
    const bRaw = unwrapped[(i + 1) % n];
    const b: LonLat = [keepLonContinuous(bRaw[0], a[0]), bRaw[1]];
    out.push([a[0], a[1]]);
    subdivide(a, b, 0);
  }
  return out;
}

/** @deprecated degree-based densify — kept for any external import */
export function densifyRing(ring: number[][], maxStepDeg: number): number[][] {
  if (ring.length < 2 || maxStepDeg <= 0) return ring;
  const out: number[][] = [];
  const n = ring.length;
  const closed =
    n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
  const last = closed ? n - 1 : n;
  for (let i = 0; i < last; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    out.push([a[0], a[1]]);
    let dLon = b[0] - a[0];
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    const dLat = b[1] - a[1];
    const dist = Math.hypot(dLon, dLat);
    const steps = Math.min(64, Math.floor(dist / maxStepDeg));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      out.push([a[0] + dLon * t, a[1] + dLat * t]);
    }
  }
  if (closed && out.length) out.push([out[0][0], out[0][1]]);
  return out;
}

export type EnuFrame = {
  origin: Vec3;
  lon0: number;
  lat0: number;
  e: Vec3;
  n: Vec3;
  u: Vec3;
};

export type ChartKind = "enu" | "polar_n" | "polar_s";

export type Chart = {
  kind: ChartKind;
  enu?: EnuFrame;
  R: number;
};

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalizeVec(v: Vec3): Vec3 {
  return ecefNormalize(v[0], v[1], v[2]);
}

export function makeEnuFrame(lon0: number, lat0: number, h = LAND_HEIGHT_M): EnuFrame {
  const origin = lonLatToEcef(lon0, lat0, h);
  const u = lonLatNormal(lon0, lat0);
  const absUp = Math.abs(u[2]);
  const ref: Vec3 = absUp > 0.95 ? [0, 1, 0] : [0, 0, 1];
  let e = normalizeVec(cross(ref, u));
  if (Math.hypot(e[0], e[1], e[2]) < 1e-12) {
    e = normalizeVec(cross([1, 0, 0], u));
  }
  const n = normalizeVec(cross(u, e));
  return { origin, lon0, lat0, e, n, u };
}

export function ecefToEnu(p: Vec3, f: EnuFrame): [number, number] {
  const dx = p[0] - f.origin[0];
  const dy = p[1] - f.origin[1];
  const dz = p[2] - f.origin[2];
  return [
    dx * f.e[0] + dy * f.e[1] + dz * f.e[2],
    dx * f.n[0] + dy * f.n[1] + dz * f.n[2],
  ];
}

/** Azimuthal equidistant about a pole: x = ρ cos λ, y = ρ sin λ. */
export function lonLatToPolar(lonDeg: number, latDeg: number, north: boolean): [number, number] {
  const R = WGS84_A;
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const rho = north ? R * (Math.PI / 2 - lat) : R * (Math.PI / 2 + lat);
  return [rho * Math.cos(lon), rho * Math.sin(lon)];
}

/** Chart centre from ECEF mean of unit directions (dateline-safe). */
export function chartCenterLonLat(ring: LonLat[]): LonLat {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const [lon, lat] of ring) {
    const p = lonLatToEcef(lon, lat, 0);
    const u = ecefNormalize(p[0], p[1], p[2]);
    x += u[0];
    y += u[1];
    z += u[2];
  }
  const n = Math.hypot(x, y, z) || 1;
  return ecefToLonLat(x / n, y / n, z / n);
}

export function makeChart(
  exterior: LonLat[],
  pole: PoleKind,
  h = LAND_HEIGHT_M
): Chart {
  if (pole === "north") return { kind: "polar_n", R: WGS84_A };
  if (pole === "south") return { kind: "polar_s", R: WGS84_A };

  const [lon0, lat0] = chartCenterLonLat(exterior);
  if (lat0 > POLAR_CHART_LAT_DEG) return { kind: "polar_n", R: WGS84_A };
  if (lat0 < -POLAR_CHART_LAT_DEG) return { kind: "polar_s", R: WGS84_A };

  return { kind: "enu", enu: makeEnuFrame(lon0, lat0, h), R: WGS84_A };
}

export function projectToChart(lon: number, lat: number, chart: Chart, h = LAND_HEIGHT_M): [number, number] {
  // Polar chart needs principal lon; ENU uses full geodetic (lon periodic in ECEF).
  if (chart.kind === "polar_n") return lonLatToPolar(normalizeLon(lon), lat, true);
  if (chart.kind === "polar_s") return lonLatToPolar(normalizeLon(lon), lat, false);
  const p = lonLatToEcef(lon, lat, h);
  return ecefToEnu(p, chart.enu!);
}

export function signedArea2D(pts: [number, number][]): number {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a / 2;
}
