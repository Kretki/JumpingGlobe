/**
 * Lightweight self-check for land projection primitives.
 * Run: npx --yes tsx src/land/project.test.ts
 */

import {
  ecefToLonLat,
  geodesicPoint,
  lonLatToEcef,
  ringEnclosesPole,
  unwrapRingLons,
  unwrappedLonSpan,
} from "./project";
import { maxEdgeMFromOrderNum } from "./lod.config";
import { featureCollectionToMesh, splitLongEdges as splitEdges } from "./mesh";
import type { GeoJsonFeatureCollection } from "./mesh";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok:", msg);
}

// Dateline unwrap
{
  const ring: [number, number][] = [
    [170, 10],
    [175, 10],
    [-175, 10],
    [-170, 10],
    [170, 10],
  ];
  const u = unwrapRingLons(ring);
  assert(u[2][0] > 180 || u[2][0] > u[1][0], "unwrapped lons monotonic across dateline");
  assert(unwrappedLonSpan(u) < 50, "unwrapped span of short dateline arc is small");
}

// Geodesic midpoint
{
  const a = lonLatToEcef(0, 0, 12);
  const b = lonLatToEcef(0, 2, 12);
  const m = geodesicPoint(a, b, 0.5, 12);
  const [lon, lat] = ecefToLonLat(m[0], m[1], m[2]);
  assert(Math.abs(lon) < 0.5, "midpoint lon near 0");
  assert(Math.abs(lat - 1) < 0.15, "midpoint lat ≈ 1°");
}

// Pole enclosure
{
  const ant: [number, number][] = [];
  for (let i = 0; i <= 36; i++) {
    const lon = -180 + (i / 36) * 360;
    ant.push([lon, -80]);
  }
  const pole = ringEnclosesPole(ant);
  assert(pole === "south", "Antarctica-like ring encloses south pole");
}

// Edge split
{
  const positions: number[] = [];
  const indices: number[] = [];
  const p0 = lonLatToEcef(0, 0, 12);
  const p1 = lonLatToEcef(5, 0, 12);
  const p2 = lonLatToEcef(0, 5, 12);
  positions.push(...p0, ...p1, ...p2);
  indices.push(0, 1, 2);
  const { maxEdge } = splitEdges(positions, indices, maxEdgeMFromOrderNum(0), 12);
  assert(maxEdge <= maxEdgeMFromOrderNum(0) * 1.05, `maxEdge ${maxEdge} ≤ budget`);
  assert(indices.length / 3 > 1, "edge split produced more triangles");
}

// Simple continent-like Africa box
{
  const fc: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [20, 0],
              [20, 15],
              [0, 15],
              [0, 0],
            ],
          ],
        },
      },
    ],
  };
  const mesh = featureCollectionToMesh(fc, 0);
  assert(mesh.triangleCount > 0, "simple polygon produces triangles");
  assert(mesh.stats.earcutEmpty + mesh.stats.earcutThrow === 0, "no earcut failures on simple poly");
  assert(
    mesh.stats.maxEdgeMObserved <= maxEdgeMFromOrderNum(0) * 1.05,
    `maxEdge observed ${mesh.stats.maxEdgeMObserved}`
  );

  const clipped = featureCollectionToMesh(fc, 0, undefined, {
    bbox: { west: 5, south: 5, east: 10, north: 10 },
    heightM: 3_000_000,
  });
  assert(clipped.triangleCount > 0, "clip to view bbox still produces triangles");
  assert(
    clipped.triangleCount <= mesh.triangleCount,
    "clipped mesh is not larger than full polygon"
  );
}

// Asia-like dateline spanning polygon (proper ring across ±180)
{
  const fc: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [170, 40],
              [175, 40],
              [-175, 40],
              [-170, 40],
              [-170, 50],
              [-175, 50],
              [175, 50],
              [170, 50],
              [170, 40],
            ],
          ],
        },
      },
    ],
  };
  const mesh = featureCollectionToMesh(fc, 0);
  assert(
    mesh.triangleCount > 0 && mesh.triangleCount < 500_000,
    `dateline polygon triangles=${mesh.triangleCount} splits=${mesh.stats.datelineSplits}`
  );
  assert(
    mesh.stats.earcutEmpty + mesh.stats.earcutThrow === 0,
    "no earcut failures on dateline poly"
  );
}

// Antarctica-like
{
  const ring: number[][] = [];
  for (let i = 0; i <= 24; i++) {
    ring.push([-180 + (i / 24) * 360, -72]);
  }
  ring.push(ring[0]);
  const fc: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
      },
    ],
  };
  const mesh = featureCollectionToMesh(fc, 0);
  assert(mesh.stats.poleHandled >= 1, "poleHandled for Antarctica-like");
  assert(mesh.triangleCount > 0, "Antarctica-like has triangles");
  // No triangle centroid should be near equator
  let bad = 0;
  const pos = mesh.positions;
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t];
    const i1 = idx[t + 1];
    const i2 = idx[t + 2];
    const z = (pos[i0 * 3 + 2] + pos[i1 * 3 + 2] + pos[i2 * 3 + 2]) / 3;
    if (z > -1e6) bad++;
  }
  assert(bad === 0, "no Antarctica triangles near/north of equator");
}

console.log("\nAll project/mesh self-checks passed.");
