/**
 * Selected-point tracking: which plate a clicked point belongs to at the shown
 * age, where that point is today, and its path through time.
 *
 * Plates come from the Merdith static polygons (present-day coordinates): a point
 * clicked at age t lies on plate P if rotating it back by P's rotation at t lands
 * inside one of P's static polygons valid at t.
 */

import { IDENTITY, quatRotate, type Quat, type RotationTree } from "./rotation";

const D2R = Math.PI / 180;

export type StaticPolygon = {
  plateId: number;
  name: string;
  fromAge: number;
  toAge: number;
  /** [exterior, ...holes] per polygon, lon/lat */
  polys: number[][][][];
  env: [number, number, number, number];
};

export type TrackedPoint = {
  plateId: number;
  name: string;
  fromAge: number;
  toAge: number;
  /** Present-day unit vector (GPlates sphere: geodetic lon/lat as spherical). */
  unit0: [number, number, number];
  presentLon: number;
  presentLat: number;
  /** Position at each sampled age; null where the plate has no rotation or did not exist. */
  track: { age: number; unit: [number, number, number] | null }[];
};

export function lonLatToUnit(lon: number, lat: number): [number, number, number] {
  const la = lat * D2R;
  const lo = lon * D2R;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

export function unitToLonLat(u: ArrayLike<number>): [number, number] {
  return [Math.atan2(u[1], u[0]) / D2R, Math.asin(Math.max(-1, Math.min(1, u[2]))) / D2R];
}

function conj(q: Quat): Quat {
  return [q[0], -q[1], -q[2], -q[3]];
}

function pointInRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Parse the /api/land FeatureCollection of merdith_static.gpkg. */
export function parseStaticPolygons(fc: {
  features: { properties?: Record<string, unknown>; geometry: { type: string; coordinates: unknown } | null }[];
}): StaticPolygon[] {
  const out: StaticPolygon[] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    const p = f.properties ?? {};
    if (!g || typeof p.plate_id !== "number") continue;
    const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as number[][][][];
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const poly of polys) {
      for (const [x, y] of poly[0]) {
        if (x < w) w = x;
        if (x > e) e = x;
        if (y < s) s = y;
        if (y > n) n = y;
      }
    }
    out.push({
      plateId: p.plate_id,
      name: typeof p.name === "string" ? p.name : "",
      fromAge: typeof p.from_age === "number" ? p.from_age : 1e6,
      toAge: typeof p.to_age === "number" ? p.to_age : 0,
      polys,
      env: [w, s, e, n],
    });
  }
  return out;
}

/** Plate under (lon, lat) as displayed at `age`, with that point's present-day position. */
export function plateAt(
  statics: StaticPolygon[],
  tree: RotationTree,
  lon: number,
  lat: number,
  age: number
): { poly: StaticPolygon; presentLon: number; presentLat: number; unit0: [number, number, number] } | null {
  const u = lonLatToUnit(lon, lat);
  const v: [number, number, number] = [0, 0, 0];
  const byPlate = new Map<number, [number, number] | null>();
  // Older-lived polygons first, so tiny overlaps resolve like the plate tagging.
  const candidates = statics.filter((sp) => age <= sp.fromAge && age >= sp.toAge).sort((a, b) => b.fromAge - a.fromAge);
  for (const sp of candidates) {
    let ll = byPlate.get(sp.plateId);
    if (ll === undefined) {
      const q = age <= 0 ? IDENTITY : tree.total(sp.plateId, age);
      if (q) {
        quatRotate(conj(q), u[0], u[1], u[2], v);
        ll = unitToLonLat(v);
      } else ll = null;
      byPlate.set(sp.plateId, ll);
    }
    if (!ll) continue;
    const [x, y] = ll;
    if (x < sp.env[0] || x > sp.env[2] || y < sp.env[1] || y > sp.env[3]) continue;
    for (const poly of sp.polys) {
      if (!pointInRing(x, y, poly[0])) continue;
      if (poly.slice(1).some((h) => pointInRing(x, y, h))) continue;
      return { poly: sp, presentLon: x, presentLat: y, unit0: lonLatToUnit(x, y) };
    }
  }
  return null;
}

/** Track a present-day point on `plateId` from 0 Ma back to `maxAge` (step in Myr). */
export function computeTrack(
  tree: RotationTree,
  sp: StaticPolygon,
  unit0: [number, number, number],
  maxAge: number,
  step = 1
): TrackedPoint["track"] {
  const track: TrackedPoint["track"] = [];
  for (let age = 0; age <= maxAge + 1e-9; age += step) {
    track.push({ age, unit: positionAt(tree, sp, unit0, age) });
  }
  return track;
}

export function positionAt(
  tree: RotationTree,
  sp: { plateId: number; fromAge: number; toAge: number },
  unit0: [number, number, number],
  age: number
): [number, number, number] | null {
  if (age > sp.fromAge || age < sp.toAge) return null;
  const q = age <= 0 ? IDENTITY : tree.total(sp.plateId, age);
  if (!q) return null;
  const out: [number, number, number] = [0, 0, 0];
  quatRotate(q, unit0[0], unit0[1], unit0[2], out);
  return out;
}

export function formatLonLat(lon: number, lat: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(lon).toFixed(2)}° ${ew}`;
}
