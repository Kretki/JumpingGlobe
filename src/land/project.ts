/** EPSG:4326 (lon/lat degrees, h meters) → ECEF on WGS84. */

export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_B = WGS84_A * (1 - WGS84_F);
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/** Geodetic lon/lat (deg) + height (m) → ECEF meters (Z = north). */
export function lonLatToEcef(lonDeg: number, latDeg: number, h = 0): [number, number, number] {
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
export function lonLatNormal(lonDeg: number, latDeg: number): [number, number, number] {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  // Geodetic normal
  const nx = cosLat * cosLon;
  const ny = cosLat * sinLon;
  const nz = sinLat;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** Great-circle-ish angular step (degrees) for edge densification. */
export function densifyRing(
  ring: number[][],
  maxStepDeg: number
): number[][] {
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
    // unwrap short path across antimeridian for interpolation only
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
  if (closed && out.length) {
    out.push([out[0][0], out[0][1]]);
  }
  return out;
}
