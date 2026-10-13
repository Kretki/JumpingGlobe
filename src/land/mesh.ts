/** Build ECEF triangle meshes from EPSG:4326 GeoJSON land polygons. */

import earcut from "earcut";
import { maxBoundaryEdgeMFromOrderNum, maxEdgeMFromOrderNum, meshLodFromHeight } from "./lod.config";
import {
  ENU_MIN_EXTENT_M,
  LAND_HEIGHT_M,
  WGS84_A,
  densifyRingGeodesic,
  geodesicPoint,
  lonLatNormal,
  lonLatToEcef,
  makeChart,
  normalizeLonLat,
  projectToChart,
  ringEnclosesPole,
  signedArea2D,
  splitRingAntimeridian,
  stripClosingVertex,
  unwrappedLonSpan,
  unwrapRingLons,
  type LonLat,
  type PoleKind,
  type Vec3,
} from "./project";

export type MeshBBox = { west: number; south: number; east: number; north: number };

// Safety cap only: index-subsampling a ring distorts the coastline, so it must
// never trigger for real data (earcut handles rings of this size fine).
const MAX_RING_VERTS = 200_000;
// Detail meshes overlap the base mesh's discard box by this much so no seam
// pixels show at the boundary; the data itself only covers the requested bbox.
const CLIP_PAD_DEG = 0.01;

export type GeoJsonGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] }
  | { type: string; coordinates: unknown };

export type GeoJsonFeature = {
  type: "Feature";
  id?: number | string;
  geometry: GeoJsonGeometry | null;
  properties?: Record<string, unknown>;
};

export type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
  count?: number;
  lod?: number;
};

export type MeshStats = {
  featuresIn: number;
  polygonsIn: number;
  polygonsOut: number;
  earcutEmpty: number;
  earcutThrow: number;
  datelineSplits: number;
  poleHandled: number;
  skippedDegenerate: number;
  zeroChartArea: number;
  vertices: number;
  triangles: number;
  maxEdgeMObserved: number;
  reasons: string[];
};

export type LandMesh = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  featureCount: number;
  triangleCount: number;
  stats: MeshStats;
};

function emptyStats(): MeshStats {
  return {
    featuresIn: 0,
    polygonsIn: 0,
    polygonsOut: 0,
    earcutEmpty: 0,
    earcutThrow: 0,
    datelineSplits: 0,
    poleHandled: 0,
    skippedDegenerate: 0,
    zeroChartArea: 0,
    vertices: 0,
    triangles: 0,
    maxEdgeMObserved: 0,
    reasons: [],
  };
}

function note(stats: MeshStats, reason: string) {
  if (stats.reasons.length < 32) stats.reasons.push(reason);
}

function uniqueVerts(ring: LonLat[]): LonLat[] {
  const out: LonLat[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-12 || Math.abs(last[1] - p[1]) > 1e-12) {
      out.push(p);
    }
  }
  if (
    out.length > 1 &&
    Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-12 &&
    Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-12
  ) {
    out.pop();
  }
  return out;
}

/**
 * Drop vertices lying on the straight lon/lat segment between their neighbours
 * (e.g. produced by ogr2ogr -segmentize). Lossless for the shape; the mesher
 * re-densifies geodesically to the LOD budget, so these only cost earcut slivers.
 */
function dropCollinear(ring: LonLat[], tolDeg = 1e-7): LonLat[] {
  if (ring.length < 4) return ring;
  const out: LonLat[] = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const c = ring[i];
    while (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const bx = bringLonNear(b[0], a[0]) - a[0];
      const by = b[1] - a[1];
      const cx = bringLonNear(c[0], a[0]) - a[0];
      const cy = c[1] - a[1];
      const len2 = cx * cx + cy * cy;
      if (len2 < 1e-24) break;
      const dot = bx * cx + by * cy;
      const cross = bx * cy - by * cx;
      if (dot > 0 && dot < len2 && cross * cross <= tolDeg * tolDeg * len2) out.pop();
      else break;
    }
    out.push(c);
  }
  return out.length >= 3 ? out : ring;
}

function pointInRing2D(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const dy = yj - yi;
    if ((yi > y) !== (yj > y) && Math.abs(dy) > 1e-18) {
      if (x < ((xj - xi) * (y - yi)) / dy + xi) inside = !inside;
    }
  }
  return inside;
}

type ClipRect = { west: number; south: number; east: number; north: number };

function lerpLonLat(a: LonLat, b: LonLat, t: number): LonLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function bringLonNear(lon: number, ref: number): number {
  let x = lon;
  while (x - ref > 180) x -= 360;
  while (ref - x > 180) x += 360;
  return x;
}

function splitBBox(b: MeshBBox): ClipRect[] {
  if (b.west <= b.east) return [{ west: b.west, south: b.south, east: b.east, north: b.north }];
  return [
    { west: b.west, south: b.south, east: 180, north: b.north },
    { west: -180, south: b.south, east: b.east, north: b.north },
  ];
}

function padMeshBBox(b: MeshBBox, pad: number): MeshBBox {
  const south = Math.max(-85, b.south - pad);
  const north = Math.min(85, b.north + pad);
  if (b.west <= b.east) {
    if (b.east - b.west + 2 * pad >= 359) {
      return { west: -180, south, east: 180, north };
    }
    let west = b.west - pad;
    let east = b.east + pad;
    if (west < -180) west += 360;
    if (east > 180) east -= 360;
    return { west, south, east, north };
  }
  let west = b.west - pad;
  let east = b.east + pad;
  if (west < -180) west += 360;
  if (east > 180) east -= 360;
  return { west, south, east, north };
}

function isWorldMeshBBox(b: MeshBBox): boolean {
  return b.west <= -179 && b.east >= 179 && b.south <= -84 && b.north >= 84;
}

function rectInLonFrame(r: ClipRect, refLon: number): ClipRect {
  // Full-longitude band (polar views): clip by latitude only, in any lon frame.
  if (r.east - r.west >= 359.999) return { west: -1e9, south: r.south, east: 1e9, north: r.north };
  let west = bringLonNear(r.west, refLon);
  let east = bringLonNear(r.east, refLon);
  if (east < west) east += 360;
  return { west, south: r.south, east, north: r.north };
}

function capRingVerts(ring: LonLat[], maxVerts: number): LonLat[] {
  if (ring.length <= maxVerts) return ring;
  const out: LonLat[] = [];
  const n = ring.length;
  for (let i = 0; i < maxVerts; i++) {
    out.push(ring[Math.floor((i * n) / maxVerts)]);
  }
  return uniqueVerts(out);
}

function ringSignedArea(ring: LonLat[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

/** Rect sides, numbered by their position on the CCW perimeter walk. */
const SIDE_SOUTH = 0;
const SIDE_EAST = 1;
const SIDE_NORTH = 2;
const SIDE_WEST = 3;

type BoundaryHit = { pt: LonLat; s: number };
type ClipChain = { pts: LonLat[]; entry: BoundaryHit; exit: BoundaryHit; used: boolean };

/** CCW perimeter coordinate (from the SW corner) of a point on `side`. */
function perimeterPos(p: LonLat, side: number, r: ClipRect): number {
  const W = r.east - r.west;
  const H = r.north - r.south;
  const c = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
  if (side === SIDE_SOUTH) return c(p[0] - r.west, W);
  if (side === SIDE_EAST) return W + c(p[1] - r.south, H);
  if (side === SIDE_NORTH) return W + H + c(r.east - p[0], W);
  return 2 * W + H + c(r.north - p[1], H);
}

/** Point at t on a→b, snapped exactly onto `side` so perimeter positions are exact. */
function boundaryHit(a: LonLat, b: LonLat, t: number, side: number, r: ClipRect): BoundaryHit {
  const pt = lerpLonLat(a, b, t);
  if (side === SIDE_WEST) pt[0] = r.west;
  else if (side === SIDE_EAST) pt[0] = r.east;
  else if (side === SIDE_SOUTH) pt[1] = r.south;
  else pt[1] = r.north;
  return { pt, s: perimeterPos(pt, side, r) };
}

/**
 * Liang–Barsky: parametric range [t0, t1] of segment a→b inside the rect (inclusive)
 * plus the sides that bound it, or null when the segment misses the rect.
 */
function clipSegment(
  a: LonLat,
  b: LonLat,
  r: ClipRect
): { t0: number; t1: number; side0: number; side1: number } | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - r.west, r.east - a[0], a[1] - r.south, r.north - a[1]];
  const sides = [SIDE_WEST, SIDE_EAST, SIDE_SOUTH, SIDE_NORTH];
  let t0 = 0;
  let t1 = 1;
  let side0 = -1;
  let side1 = -1;
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) {
      if (q[k] < 0) return null;
      continue;
    }
    const t = q[k] / p[k];
    if (p[k] < 0) {
      if (t > t0) {
        t0 = t;
        side0 = sides[k];
      }
    } else if (t < t1) {
      t1 = t;
      side1 = sides[k];
    }
  }
  if (t0 > t1) return null;
  return { t0, t1, side0, side1 };
}

function insideRect(p: LonLat, r: ClipRect): boolean {
  return p[0] >= r.west && p[0] <= r.east && p[1] >= r.south && p[1] <= r.north;
}

/**
 * Cut a closed ring into the runs that lie inside the rect. Returns null when the
 * whole ring is inside (keep it as-is) and [] when nothing of it is inside.
 */
function ringChains(ring: LonLat[], r: ClipRect): ClipChain[] | null {
  const n = ring.length;
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (!insideRect(ring[i], r)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const chains: ClipChain[] = [];
  let cur: { pts: LonLat[]; entry: BoundaryHit } | null = null;
  for (let k = 0; k < n; k++) {
    const a = ring[(start + k) % n];
    const b = ring[(start + k + 1) % n];
    const seg = clipSegment(a, b, r);
    if (!seg) continue;
    if (seg.side0 >= 0 || !cur) {
      // a is outside (or exactly on the boundary after an exit): the ring enters here.
      const entry =
        seg.side0 >= 0
          ? boundaryHit(a, b, seg.t0, seg.side0, r)
          : { pt: a, s: perimeterPos(a, nearestSide(a, r), r) };
      cur = { pts: [entry.pt], entry };
    }
    if (seg.side1 >= 0) {
      const exit = boundaryHit(a, b, seg.t1, seg.side1, r);
      cur.pts.push(exit.pt);
      const pts = uniqueVerts(cur.pts);
      // Runs that only touch the boundary at a point enclose nothing.
      if (pts.length >= 2) chains.push({ pts, entry: cur.entry, exit, used: false });
      cur = null;
    } else {
      cur.pts.push(b);
    }
  }
  return chains;
}

function nearestSide(p: LonLat, r: ClipRect): number {
  const d = [p[1] - r.south, r.east - p[0], r.north - p[1], p[0] - r.west];
  let best = 0;
  for (let k = 1; k < 4; k++) if (d[k] < d[best]) best = k;
  return best;
}

/**
 * Exact polygon ∩ rect (Weiler–Atherton specialised to an axis-aligned rect).
 *
 * Sutherland–Hodgman returns ONE ring per input ring: separate pieces of land stay
 * linked by zero-width "bridge" edges along the rect border, and earcut fills the
 * water between them. Here every inside run of the exterior/holes is cut out and
 * runs are re-joined only by walking the rect border CCW from an exit to the next
 * entry, so each disjoint piece becomes its own polygon.
 */
function clipPolygonToRect(
  exteriorIn: LonLat[],
  holesIn: LonLat[][],
  r: ClipRect
): { exterior: LonLat[]; holes: LonLat[][] }[] {
  // Exterior CCW / holes CW: land is always on the left of travel, so the border
  // walk from an exit to the next entry is CCW.
  const exterior = ringSignedArea(exteriorIn) < 0 ? exteriorIn.slice().reverse() : exteriorIn;
  const holes = holesIn
    .filter((h) => h.length >= 3)
    .map((h) => (ringSignedArea(h) > 0 ? h.slice().reverse() : h));

  const chains: ClipChain[] = [];
  const insideHoles: LonLat[][] = [];
  const crossingOrOutsideHoles: LonLat[][] = [];

  const extChains = ringChains(exterior, r);
  if (extChains === null) {
    // Exterior fully inside ⇒ its holes are too.
    return [{ exterior, holes }];
  }
  chains.push(...extChains);
  for (const h of holes) {
    const hc = ringChains(h, r);
    if (hc === null) insideHoles.push(h);
    else {
      chains.push(...hc);
      crossingOrOutsideHoles.push(h);
    }
  }

  const rectRing = (): LonLat[] => [
    [r.west, r.south],
    [r.east, r.south],
    [r.east, r.north],
    [r.west, r.north],
  ];

  const exteriors: LonLat[][] = [];
  if (!chains.length) {
    // No boundary crossings: the rect is either entirely land or entirely water.
    const cx = (r.west + r.east) / 2;
    const cy = (r.south + r.north) / 2;
    if (!pointInRing2D(cx, cy, exterior as [number, number][])) return [];
    for (const h of crossingOrOutsideHoles) {
      if (pointInRing2D(cx, cy, h as [number, number][])) return [];
    }
    exteriors.push(rectRing());
  } else {
    const W = r.east - r.west;
    const H = r.north - r.south;
    const P = 2 * W + 2 * H;
    const corners: { s: number; pt: LonLat }[] = [
      { s: W, pt: [r.east, r.south] },
      { s: W + H, pt: [r.east, r.north] },
      { s: 2 * W + H, pt: [r.west, r.north] },
      { s: P, pt: [r.west, r.south] },
    ];
    const ccw = (from: number, to: number) => {
      const d = (to - from) % P;
      return d < 0 ? d + P : d;
    };
    const nextChain = (from: number): ClipChain => {
      let best = chains[0];
      let bestD = Infinity;
      for (const c of chains) {
        const d = ccw(from, c.entry.s);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return best;
    };

    for (const first of chains) {
      if (first.used) continue;
      const ring: LonLat[] = [];
      let cur = first;
      for (let guard = 0; guard <= chains.length; guard++) {
        cur.used = true;
        for (const p of cur.pts) ring.push(p);
        const next = nextChain(cur.exit.s);
        const span = ccw(cur.exit.s, next.entry.s);
        const passed = corners
          .map((c) => ({ d: ccw(cur.exit.s, c.s), pt: c.pt }))
          .filter((c) => c.d > 0 && c.d < span)
          .sort((a, b) => a.d - b.d);
        for (const c of passed) ring.push([c.pt[0], c.pt[1]]);
        if (next === first || next.used) break;
        cur = next;
      }
      const clean = uniqueVerts(ring);
      if (clean.length >= 3 && ringSignedArea(clean) > 0) exteriors.push(clean);
    }
  }

  const out = exteriors.map((e) => ({ exterior: e, holes: [] as LonLat[][] }));
  for (const h of insideHoles) {
    const owner = out.find((o) => pointInRing2D(h[0][0], h[0][1], o.exterior as [number, number][]));
    if (owner) owner.holes.push(h);
  }
  return out;
}

function clipPreparedPiece(
  piece: { exterior: LonLat[]; holes: LonLat[][]; pole: PoleKind },
  bbox: MeshBBox
): { exterior: LonLat[]; holes: LonLat[][]; pole: PoleKind }[] {
  const ref = piece.exterior[0][0];
  const out: { exterior: LonLat[]; holes: LonLat[][]; pole: PoleKind }[] = [];
  for (const raw of splitBBox(bbox)) {
    let r = rectInLonFrame(raw, ref);
    if (r.east - r.west > 720) {
      // Full-longitude band: clip by latitude only, with a finite rect around the ring.
      let minL = Infinity;
      let maxL = -Infinity;
      for (const p of piece.exterior) {
        minL = Math.min(minL, p[0]);
        maxL = Math.max(maxL, p[0]);
      }
      r = { west: minL - 1, south: r.south, east: maxL + 1, north: r.north };
    }
    for (const part of clipPolygonToRect(piece.exterior, piece.holes, r)) {
      const exterior = capRingVerts(part.exterior, MAX_RING_VERTS);
      if (exterior.length < 3) continue;
      out.push({
        exterior,
        holes: part.holes.map((h) => capRingVerts(h, MAX_RING_VERTS)),
        pole: ringEnclosesPole(exterior),
      });
    }
  }
  return out;
}

/** Prepare exterior (+ holes) into simple chart-ready pieces. */
function preparePolygonPieces(
  rings: number[][][],
  stats: MeshStats
): { exterior: LonLat[]; holes: LonLat[][]; pole: PoleKind }[] {
  if (!rings.length) return [];
  const exteriorIn = dropCollinear(stripClosingVertex(rings[0]));
  if (exteriorIn.length < 3) {
    stats.skippedDegenerate++;
    note(stats, "degenerate_ring");
    return [];
  }

  let pole = ringEnclosesPole(exteriorIn);
  let exteriors: LonLat[][] = [];

  if (pole) {
    // Prefer single ring + polar azimuthal chart (no meridian surgery unless needed).
    stats.poleHandled++;
    exteriors = [unwrapRingLons(exteriorIn)];
  } else {
    const unwrapped = unwrapRingLons(exteriorIn);
    if (unwrappedLonSpan(unwrapped) > 180) {
      const parts = splitRingAntimeridian(exteriorIn);
      stats.datelineSplits += Math.max(0, parts.length);
      exteriors = parts.length ? parts : [unwrapped];
    } else {
      exteriors = [unwrapped];
    }
  }

  const holeInputs = rings
    .slice(1)
    .map((r) => unwrapRingLons(dropCollinear(stripClosingVertex(r))));

  const pieces: { exterior: LonLat[]; holes: LonLat[][]; pole: PoleKind }[] = [];
  for (const ext of exteriors) {
    const e = uniqueVerts(ext);
    if (e.length < 3) {
      stats.skippedDegenerate++;
      note(stats, "degenerate_ring");
      continue;
    }
    // Assign holes whose centroid falls in this exterior (unwrapped lon/lat approx)
    const holes: LonLat[][] = [];
    for (const h of holeInputs) {
      if (h.length < 3) continue;
      let cx = 0;
      let cy = 0;
      for (const p of h) {
        cx += p[0];
        cy += p[1];
      }
      cx /= h.length;
      cy /= h.length;
      // point-in-polygon in unwrapped lon/lat
      if (pointInRing2D(cx, cy, e as [number, number][])) {
        holes.push(uniqueVerts(h));
      }
    }
    // Re-detect pole for chart choice on this piece
    const piecePole = pole ?? ringEnclosesPole(e);
    pieces.push({ exterior: e, holes, pole: piecePole });
  }
  return pieces;
}

/**
 * Mesh a polar-enclosing ring as concentric lat bands.
 * Boundary is the densified exterior; interior is filled toward the pole.
 */
function meshPolarCap(
  exterior: LonLat[],
  pole: "north" | "south",
  maxEdgeM: number,
  stats: MeshStats
): { lonlat: LonLat[]; tri: number[] } | null {
  if (exterior.length < 3) {
    stats.skippedDegenerate++;
    note(stats, "degenerate_ring");
    return null;
  }

  let sumLat = 0;
  for (const p of exterior) sumLat += p[1];
  const boundaryLat = sumLat / exterior.length;
  const poleLat = pole === "north" ? 90 : -90;
  const latSpanDeg = Math.abs(poleLat - boundaryLat);
  if (latSpanDeg < 1e-6) {
    stats.skippedDegenerate++;
    note(stats, "degenerate_ring");
    return null;
  }

  // metres per degree latitude ≈ 111320
  const mPerDegLat = 111320;
  const nRings = Math.max(1, Math.ceil((latSpanDeg * mPerDegLat) / maxEdgeM));

  // Azimuth resolution from boundary parallel circumference
  const latRad = (Math.abs(boundaryLat) * Math.PI) / 180;
  const parR = WGS84_A * Math.cos(latRad);
  const circ = 2 * Math.PI * Math.max(parR, 1);
  const nAz = Math.max(
    exterior.length,
    Math.ceil(circ / maxEdgeM),
    12
  );

  const lonlat: LonLat[] = [];
  // ring 0 = pole
  lonlat.push([0, poleLat]);
  const ringStart: number[] = [0];

  for (let r = 1; r <= nRings; r++) {
    ringStart.push(lonlat.length);
    const t = r / nRings;
    const lat = poleLat + t * (boundaryLat - poleLat);
    if (r === nRings) {
      // use actual exterior samples (rewrapped to nAz by nearest lon)
      for (const p of exterior) lonlat.push(normalizeLonLat(p));
    } else {
      for (let k = 0; k < nAz; k++) {
        const lon = -180 + (k / nAz) * 360;
        lonlat.push([lon, lat]);
      }
    }
  }

  const tri: number[] = [];
  // pole fan to first ring
  {
    const start = ringStart[1];
    const count = (ringStart[2] ?? lonlat.length) - start;
    for (let k = 0; k < count; k++) {
      const a = start + k;
      const b = start + ((k + 1) % count);
      if (pole === "south") tri.push(0, a, b);
      else tri.push(0, b, a);
    }
  }
  // quad strips between rings
  for (let r = 1; r < nRings; r++) {
    const s0 = ringStart[r];
    const s1 = ringStart[r + 1];
    const c0 = (ringStart[r + 1] ?? lonlat.length) - s0;
    const c1 = (ringStart[r + 2] ?? lonlat.length) - s1;
    // both rings should match nAz except last may be exterior.length
    const count = Math.min(c0, c1);
    if (count < 3) continue;
    for (let k = 0; k < count; k++) {
      // map k along each ring
      const a0 = s0 + (Math.floor((k / count) * c0) % c0);
      const a1 = s0 + (Math.floor(((k + 1) / count) * c0) % c0);
      const b0 = s1 + (Math.floor((k / count) * c1) % c1);
      const b1 = s1 + (Math.floor(((k + 1) / count) * c1) % c1);
      if (pole === "south") {
        tri.push(a0, b0, b1);
        tri.push(a0, b1, a1);
      } else {
        tri.push(a0, b1, b0);
        tri.push(a0, a1, b1);
      }
    }
  }

  if (!tri.length) {
    stats.earcutEmpty++;
    note(stats, "earcut_empty");
    return null;
  }
  return { lonlat, tri };
}

function triangulatePiece(
  exterior: LonLat[],
  holes: LonLat[][],
  pole: PoleKind,
  boundaryMaxM: number,
  stats: MeshStats
): { lonlat: LonLat[]; tri: number[] } | null {
  // Pre-densify only very long edges (2× budget) so earcut stays well-conditioned
  // without creating a dense skinny-triangle soup. Final spacing comes from splitLongEdges.
  const preMax = Math.max(boundaryMaxM * 2, boundaryMaxM);
  const densExt = densifyRingGeodesic(exterior, preMax);
  const densHoles = holes.map((h) => densifyRingGeodesic(h, preMax));

  const extU = uniqueVerts(densExt);
  if (extU.length < 3) {
    stats.skippedDegenerate++;
    note(stats, "degenerate_ring");
    return null;
  }

  // Pole caps: structured lat/lon grid from pole to boundary (no Rivara explosion)
  if (pole === "north" || pole === "south") {
    return meshPolarCap(extU, pole, boundaryMaxM, stats);
  }

  const chart = makeChart(extU, pole);
  const pts2d: [number, number][] = [];
  const lonlat: LonLat[] = [];
  const holeIndices: number[] = [];

  const pushRing = (ring: LonLat[], isHole: boolean) => {
    const local2d: [number, number][] = [];
    for (const p of ring) {
      local2d.push(projectToChart(p[0], p[1], chart));
    }
    let area = signedArea2D(local2d);
    let order = ring;
    let ordered2d = local2d;
    if (!isHole && area < 0) {
      order = ring.slice().reverse();
      ordered2d = local2d.slice().reverse();
      area = -area;
    }
    if (isHole && area > 0) {
      order = ring.slice().reverse();
      ordered2d = local2d.slice().reverse();
      area = -area;
    }
    void ENU_MIN_EXTENT_M;
    void area;
    if (isHole) holeIndices.push(lonlat.length);
    for (let i = 0; i < order.length; i++) {
      lonlat.push(order[i]);
      pts2d.push(ordered2d[i]);
    }
  };

  pushRing(extU, false);
  for (const h of densHoles) {
    const hu = uniqueVerts(h);
    if (hu.length >= 3) pushRing(hu, true);
  }

  if (lonlat.length < 3) {
    stats.skippedDegenerate++;
    note(stats, "degenerate_ring");
    return null;
  }

  const extArea = (() => {
    const n = holeIndices.length ? holeIndices[0] : pts2d.length;
    return Math.abs(signedArea2D(pts2d.slice(0, n)));
  })();
  if (extArea < 1e-6) {
    stats.zeroChartArea++;
    note(stats, "zero_chart_area");
    return null;
  }

  const flat: number[] = [];
  for (const p of pts2d) flat.push(p[0], p[1]);

  let tri: number[];
  try {
    tri = earcut(flat, holeIndices.length ? holeIndices : undefined, 2);
  } catch {
    stats.earcutThrow++;
    note(stats, "earcut_throw");
    return null;
  }
  if (!tri.length) {
    stats.earcutEmpty++;
    note(stats, "earcut_empty");
    return null;
  }
  return { lonlat, tri };
}

function ensureOutward(
  positions: number[],
  i0: number,
  i1: number,
  i2: number
): [number, number, number] {
  const ax = positions[i0 * 3];
  const ay = positions[i0 * 3 + 1];
  const az = positions[i0 * 3 + 2];
  const bx = positions[i1 * 3] - ax;
  const by = positions[i1 * 3 + 1] - ay;
  const bz = positions[i1 * 3 + 2] - az;
  const cx = positions[i2 * 3] - ax;
  const cy = positions[i2 * 3 + 1] - ay;
  const cz = positions[i2 * 3 + 2] - az;
  const nx = by * cz - bz * cy;
  const ny = bz * cx - bx * cz;
  const nz = bx * cy - by * cx;
  // outward if n · a > 0 (origin inside earth)
  const dot = nx * ax + ny * ay + nz * az;
  if (dot < 0) return [i0, i2, i1];
  return [i0, i1, i2];
}

function edgeLen(positions: number[], i: number, j: number): number {
  return Math.hypot(
    positions[i * 3] - positions[j * 3],
    positions[i * 3 + 1] - positions[j * 3 + 1],
    positions[i * 3 + 2] - positions[j * 3 + 2]
  );
}

function pushOutward(
  next: number[],
  positions: number[],
  a: number,
  b: number,
  c: number
) {
  const [i0, i1, i2] = ensureOutward(positions, a, b, c);
  next.push(i0, i1, i2);
}

/**
 * Rivara longest-edge bisection: each pass splits only the longest edge of each
 * triangle (shared midpoints). Avoids multi-edge patterns that re-introduce
 * longer diagonals on spherical caps.
 */
export function splitLongEdges(
  positions: number[],
  indices: number[],
  maxEdgeM: number,
  h = LAND_HEIGHT_M,
  maxIter = 24
): { maxEdge: number } {
  const budget = maxEdgeM * 1.02;
  // Numeric key (vertex indices stay far below 2^26 per piece) — much cheaper than strings.
  const edgeKey = (i: number, j: number) => (i < j ? i * 67108864 + j : j * 67108864 + i);

  // Triangles under budget never change again (their vertices are fixed), so move
  // them out once instead of re-measuring them on every pass.
  const done: number[] = [];
  let active = indices.slice();

  for (let pass = 0; pass < maxIter; pass++) {
    const midCache = new Map<number, number>();
    const getMid = (i: number, j: number): number => {
      const key = edgeKey(i, j);
      const hit = midCache.get(key);
      if (hit !== undefined) return hit;
      const p0: Vec3 = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
      const p1: Vec3 = [positions[j * 3], positions[j * 3 + 1], positions[j * 3 + 2]];
      const pm = geodesicPoint(p0, p1, 0.5, h);
      const idx = positions.length / 3;
      positions.push(pm[0], pm[1], pm[2]);
      midCache.set(key, idx);
      return idx;
    };

    const nxt: number[] = [];
    for (let t = 0; t < active.length; t += 3) {
      const a = active[t];
      const b = active[t + 1];
      const c = active[t + 2];
      const lab = edgeLen(positions, a, b);
      const lbc = edgeLen(positions, b, c);
      const lca = edgeLen(positions, c, a);
      const longest = Math.max(lab, lbc, lca);
      if (longest <= budget) {
        pushOutward(done, positions, a, b, c);
        continue;
      }
      if (lab >= lbc && lab >= lca) {
        const m = getMid(a, b);
        pushOutward(nxt, positions, a, m, c);
        pushOutward(nxt, positions, m, b, c);
      } else if (lbc >= lab && lbc >= lca) {
        const m = getMid(b, c);
        pushOutward(nxt, positions, a, b, m);
        pushOutward(nxt, positions, a, m, c);
      } else {
        const m = getMid(c, a);
        pushOutward(nxt, positions, a, b, m);
        pushOutward(nxt, positions, b, c, m);
      }
    }
    active = nxt;
    if (!active.length) break;
  }

  // Leftovers when maxIter is exhausted keep their (over-budget) edges.
  indices.length = 0;
  for (let i = 0; i < done.length; i++) indices.push(done[i]);
  for (let i = 0; i < active.length; i++) indices.push(active[i]);

  let maxEdge = 0;
  for (let t = 0; t < indices.length; t += 3) {
    maxEdge = Math.max(
      maxEdge,
      edgeLen(positions, indices[t], indices[t + 1]),
      edgeLen(positions, indices[t + 1], indices[t + 2]),
      edgeLen(positions, indices[t + 2], indices[t])
    );
  }
  return { maxEdge };
}

/**
 * Flat triangles with edges ≤ edgeM sag below the ellipsoid by at most ~L²/(6R)
 * (circumradius of an equilateral triangle). Lift coarse LODs by that sag so they
 * never dip into the ocean, which lets world-scale LODs use much larger triangles.
 */
function landHeightForEdgeM(edgeM: number): number {
  return LAND_HEIGHT_M + (edgeM * edgeM) / (6 * WGS84_A);
}

function appendPiece(
  exterior: LonLat[],
  holes: LonLat[][],
  pole: PoleKind,
  lod: number,
  positions: number[],
  normals: number[],
  indices: number[],
  stats: MeshStats
): number {
  const boundaryMax = maxBoundaryEdgeMFromOrderNum(lod);
  const edgeMax = maxEdgeMFromOrderNum(lod);
  const landH = landHeightForEdgeM(Math.max(edgeMax, boundaryMax));
  const result = triangulatePiece(exterior, holes, pole, boundaryMax, stats);
  if (!result) return 0;

  const localPos: number[] = [];
  const localIdx: number[] = [];
  const baseLonLat: LonLat[] = result.lonlat;

  for (const [lon, lat] of baseLonLat) {
    const ll = normalizeLonLat([lon, lat]);
    const [x, y, z] = lonLatToEcef(ll[0], ll[1], landH);
    localPos.push(x, y, z);
  }
  for (let i = 0; i < result.tri.length; i += 3) {
    const [a, b, c] = ensureOutward(
      localPos,
      result.tri[i],
      result.tri[i + 1],
      result.tri[i + 2]
    );
    localIdx.push(a, b, c);
  }

  const { maxEdge } = splitLongEdges(localPos, localIdx, edgeMax, landH);
  stats.maxEdgeMObserved = Math.max(stats.maxEdgeMObserved, maxEdge);
  if (maxEdge > edgeMax * 1.05) note(stats, "undercut");

  // Normals for all verts (including split midpoints via ecef→lonlat)
  const base = positions.length / 3;
  const vertCount = localPos.length / 3;
  for (let i = 0; i < vertCount; i++) {
    const x = localPos[i * 3];
    const y = localPos[i * 3 + 1];
    const z = localPos[i * 3 + 2];
    positions.push(x, y, z);
    // recover lon/lat from ECEF for normal
    const lon = (Math.atan2(y, x) * 180) / Math.PI;
    const p = Math.hypot(x, y);
    const lat = (Math.atan2(z, p) * 180) / Math.PI;
    const [nx, ny, nz] = lonLatNormal(lon, lat);
    normals.push(nx, ny, nz);
  }
  let tris = 0;
  for (let i = 0; i < localIdx.length; i += 3) {
    indices.push(base + localIdx[i], base + localIdx[i + 1], base + localIdx[i + 2]);
    tris++;
  }
  stats.polygonsOut++;
  return tris;
}

function processPolygonRings(
  rings: number[][][],
  lod: number,
  positions: number[],
  normals: number[],
  indices: number[],
  stats: MeshStats,
  clipBBox?: MeshBBox
): number {
  stats.polygonsIn++;
  let pieces = preparePolygonPieces(rings, stats);
  if (clipBBox && !isWorldMeshBBox(clipBBox)) {
    const padded = padMeshBBox(clipBBox, CLIP_PAD_DEG);
    const clipped: typeof pieces = [];
    for (const piece of pieces) {
      clipped.push(...clipPreparedPiece(piece, padded));
    }
    pieces = clipped;
  }
  let tris = 0;
  for (const piece of pieces) {
    tris += appendPiece(
      piece.exterior,
      piece.holes,
      piece.pole,
      lod,
      positions,
      normals,
      indices,
      stats
    );
  }
  return tris;
}

export type MeshProgressFn = (done: number, total: number) => void;

export type MeshBuildOpts = {
  bbox?: MeshBBox;
  heightM?: number;
};

/** Convert a FeatureCollection (EPSG:4326) into a single ECEF mesh. */
export function featureCollectionToMesh(
  fc: GeoJsonFeatureCollection,
  lod = 0,
  onProgress?: MeshProgressFn,
  opts?: MeshBuildOpts
): LandMesh {
  const tessLod = opts?.heightM != null ? meshLodFromHeight(opts.heightM) : lod;
  const clipBBox = opts?.bbox;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const stats = emptyStats();
  stats.featuresIn = fc.features.length;
  let featureCount = 0;
  let triangleCount = 0;
  const total = Math.max(1, fc.features.length);
  let processed = 0;
  let lastEmit = -1;

  const report = (frac = 0) => {
    if (!onProgress) return;
    const v = Math.min(total, processed + frac);
    if (v === lastEmit && processed < total) return;
    lastEmit = v;
    onProgress(v, total);
  };
  report();

  for (const f of fc.features) {
    if (!f.geometry) {
      processed++;
      report();
      continue;
    }
    const g = f.geometry;
    let tris = 0;
    if (g.type === "Polygon") {
      report(0.25);
      tris = processPolygonRings(
        g.coordinates as number[][][],
        tessLod,
        positions,
        normals,
        indices,
        stats,
        clipBBox
      );
    } else if (g.type === "MultiPolygon") {
      const polys = g.coordinates as number[][][][];
      const n = Math.max(1, polys.length);
      for (let i = 0; i < polys.length; i++) {
        report(i / n);
        tris += processPolygonRings(
          polys[i],
          tessLod,
          positions,
          normals,
          indices,
          stats,
          clipBBox
        );
      }
    }
    if (tris > 0) {
      featureCount++;
      triangleCount += tris;
    }
    processed++;
    report();
  }

  stats.vertices = positions.length / 3;
  stats.triangles = triangleCount;

  if (typeof console !== "undefined" && console.info) {
    console.info("[land mesh]", {
      lod: tessLod,
      features: featureCount,
      triangles: triangleCount,
      vertices: stats.vertices,
      earcutEmpty: stats.earcutEmpty,
      earcutThrow: stats.earcutThrow,
      datelineSplits: stats.datelineSplits,
      poleHandled: stats.poleHandled,
      maxEdgeMObserved: Math.round(stats.maxEdgeMObserved),
      reasons: stats.reasons.slice(0, 8),
    });
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    featureCount,
    triangleCount,
    stats,
  };
}
