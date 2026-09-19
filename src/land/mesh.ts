/** Build ECEF triangle meshes from EPSG:4326 GeoJSON land polygons. */

import earcut from "earcut";
import { densifyRing, lonLatNormal, lonLatToEcef } from "./project";

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

export type LandMesh = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  featureCount: number;
  triangleCount: number;
};

const LAND_HEIGHT_M = 80; // lift slightly above ellipsoid to reduce z-fighting

function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return a / 2;
}

function stripClose(ring: number[][]): number[][] {
  if (ring.length < 2) return ring;
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  return ring;
}

function flattenPolygon(
  rings: number[][][],
  maxStepDeg: number
): { flat: number[]; holes: number[]; lonlat: number[][] } | null {
  if (!rings.length) return null;
  const flat: number[] = [];
  const holes: number[] = [];
  const lonlat: number[][] = [];

  for (let r = 0; r < rings.length; r++) {
    let ring = densifyRing(rings[r], maxStepDeg);
    ring = stripClose(ring);
    if (ring.length < 3) continue;

    // Exterior CCW, holes CW in lon/lat (earcut expects this with y-up)
    const area = ringArea(ring);
    if (r === 0 && area < 0) ring = ring.slice().reverse();
    if (r > 0 && area > 0) ring = ring.slice().reverse();

    if (r > 0) holes.push(lonlat.length);

    for (const p of ring) {
      flat.push(p[0], p[1]);
      lonlat.push(p);
    }
  }

  if (lonlat.length < 3) return null;
  return { flat, holes, lonlat };
}

function appendFeature(
  geometry: GeoJsonGeometry,
  maxStepDeg: number,
  positions: number[],
  normals: number[],
  indices: number[]
): number {
  let tris = 0;
  const polys: number[][][][] =
    geometry.type === "Polygon"
      ? [geometry.coordinates as number[][][]]
      : geometry.type === "MultiPolygon"
        ? (geometry.coordinates as number[][][][])
        : [];

  for (const rings of polys) {
    const flatPoly = flattenPolygon(rings, maxStepDeg);
    if (!flatPoly) continue;

    let tri: number[];
    try {
      tri = earcut(flatPoly.flat, flatPoly.holes, 2);
    } catch {
      continue;
    }
    if (!tri.length) continue;

    const base = positions.length / 3;
    for (const [lon, lat] of flatPoly.lonlat) {
      const [x, y, z] = lonLatToEcef(lon, lat, LAND_HEIGHT_M);
      positions.push(x, y, z);
      const [nx, ny, nz] = lonLatNormal(lon, lat);
      normals.push(nx, ny, nz);
    }
    for (let i = 0; i < tri.length; i += 3) {
      indices.push(base + tri[i], base + tri[i + 1], base + tri[i + 2]);
      tris++;
    }
  }
  return tris;
}

/** Convert a FeatureCollection (EPSG:4326) into a single ECEF mesh. */
export function featureCollectionToMesh(
  fc: GeoJsonFeatureCollection,
  maxStepDeg = 2.5
): LandMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let featureCount = 0;
  let triangleCount = 0;

  for (const f of fc.features) {
    if (!f.geometry) continue;
    const t = appendFeature(f.geometry, maxStepDeg, positions, normals, indices);
    if (t > 0) {
      featureCount++;
      triangleCount += t;
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    featureCount,
    triangleCount,
  };
}
