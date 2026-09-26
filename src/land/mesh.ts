/** Build ECEF triangle meshes from EPSG:4326 GeoJSON land polygons. */

import earcut from "earcut";
import {
  ENU_MIN_EXTENT_M,
  LAND_HEIGHT_M,
  MAX_BOUNDARY_EDGE_M,
  MAX_EDGE_M,
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

/** Prepare exterior (+ holes) into simple chart-ready pieces. */
function preparePolygonPieces(
  rings: number[][][],
  stats: MeshStats
): { exterior: LonLat[]; holes: LonLat[][]; pole: PoleKind }[] {
  if (!rings.length) return [];
  const exteriorIn = stripClosingVertex(rings[0]);
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

  const holeInputs = rings.slice(1).map((r) => unwrapRingLons(stripClosingVertex(r)));

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
  const edgeKey = (i: number, j: number) => (i < j ? i + "," + j : j + "," + i);

  for (let pass = 0; pass < maxIter; pass++) {
    const midCache = new Map<string, number>();
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
    let any = false;
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t];
      const b = indices[t + 1];
      const c = indices[t + 2];
      const lab = edgeLen(positions, a, b);
      const lbc = edgeLen(positions, b, c);
      const lca = edgeLen(positions, c, a);
      const longest = Math.max(lab, lbc, lca);
      if (longest <= budget) {
        pushOutward(nxt, positions, a, b, c);
        continue;
      }
      any = true;
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
    indices.length = 0;
    for (let i = 0; i < nxt.length; i++) indices.push(nxt[i]);
    if (!any) break;
  }

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

function appendPiece(
  exterior: LonLat[],
  holes: LonLat[][],
  pole: PoleKind,
  lod: 0 | 1 | 2,
  positions: number[],
  normals: number[],
  indices: number[],
  stats: MeshStats
): number {
  const boundaryMax = MAX_BOUNDARY_EDGE_M[lod];
  const edgeMax = MAX_EDGE_M[lod];
  const result = triangulatePiece(exterior, holes, pole, boundaryMax, stats);
  if (!result) return 0;

  const localPos: number[] = [];
  const localIdx: number[] = [];
  const baseLonLat: LonLat[] = result.lonlat;

  for (const [lon, lat] of baseLonLat) {
    const ll = normalizeLonLat([lon, lat]);
    const [x, y, z] = lonLatToEcef(ll[0], ll[1], LAND_HEIGHT_M);
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

  const { maxEdge } = splitLongEdges(localPos, localIdx, edgeMax, LAND_HEIGHT_M);
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
  lod: 0 | 1 | 2,
  positions: number[],
  normals: number[],
  indices: number[],
  stats: MeshStats
): number {
  stats.polygonsIn++;
  const pieces = preparePolygonPieces(rings, stats);
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

/** Convert a FeatureCollection (EPSG:4326) into a single ECEF mesh. */
export function featureCollectionToMesh(
  fc: GeoJsonFeatureCollection,
  lod: 0 | 1 | 2 = 0,
  onProgress?: MeshProgressFn
): LandMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const stats = emptyStats();
  stats.featuresIn = fc.features.length;
  let featureCount = 0;
  let triangleCount = 0;
  const total = Math.max(1, fc.features.length);
  let processed = 0;
  let lastPct = -1;

  const report = () => {
    if (!onProgress) return;
    const pct = Math.floor((processed / total) * 100);
    if (pct === lastPct && processed < total) return;
    lastPct = pct;
    onProgress(processed, total);
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
      tris = processPolygonRings(
        g.coordinates as number[][][],
        lod,
        positions,
        normals,
        indices,
        stats
      );
    } else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates as number[][][][]) {
        tris += processPolygonRings(poly, lod, positions, normals, indices, stats);
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
      lod,
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
