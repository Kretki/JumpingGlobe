/**
 * Lightweight self-check for land projection, meshing and plate rotation primitives.
 * Run: npm run test:land
 */

import { ecefToLonLat, lonLatToEcef } from "../geodesy/wgs84Ellipsoid";
import { RotationTree } from "../plates/rotationTree";
import { quatFromPole, quatRotate, quatSlerp } from "../plates/quaternionMath";
import { unwrapRingLons, unwrappedLonSpan } from "./antimeridianSplit";
import { splitLongEdges } from "./edgeRefinement";
import { geodesicPoint } from "./geodesicDensify";
import { maxEdgeMFromOrderNum } from "./lod.config";
import { featureCollectionToMesh } from "./meshBuilder";
import type { GeoJsonFeatureCollection, LandMesh } from "./meshTypes";
import { ringEnclosesPole } from "./poleDetection";

/**
 * Throw when a condition fails, log it otherwise.
 *
 * Usage: every check below.
 *
 * @param condition - Checked condition.
 * @param checkName - Description printed with the result.
 * @returns Nothing.
 * @throws Error when the condition is false.
 */
function assertCheck(condition: boolean, checkName: string): void {
  if (!condition) throw new Error("FAIL: " + checkName);
  console.log("ok:", checkName);
}

/**
 * Wrap one polygon in a FeatureCollection.
 *
 * Usage: test fixtures.
 *
 * @param polygonRings - GeoJSON rings.
 * @returns FeatureCollection with one Polygon feature.
 */
function singlePolygon(polygonRings: number[][][]): GeoJsonFeatureCollection {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: polygonRings } }],
  };
}

/**
 * Whether any triangle of a mesh covers a lon/lat point (planar test in lon/lat).
 *
 * Usage: clipping checks.
 *
 * @param landMesh - Mesh to test.
 * @param longitudeDeg - Point longitude.
 * @param latitudeDeg - Point latitude.
 * @returns True when covered.
 */
function isCovered(landMesh: LandMesh, longitudeDeg: number, latitudeDeg: number): boolean {
  const positionData = landMesh.positions;
  const vertexLonLat = (vertexIdx: number) =>
    ecefToLonLat(positionData[vertexIdx * 3], positionData[vertexIdx * 3 + 1], positionData[vertexIdx * 3 + 2]);
  const sideOfEdge = (startPoint: number[], endPoint: number[]) =>
    (endPoint[0] - startPoint[0]) * (latitudeDeg - startPoint[1]) - (endPoint[1] - startPoint[1]) * (longitudeDeg - startPoint[0]);
  const triangleIndices = landMesh.triangleIndices;
  for (let triangleStart = 0; triangleStart < triangleIndices.length; triangleStart += 3) {
    const triangleCornerA = vertexLonLat(triangleIndices[triangleStart]);
    const triangleCornerB = vertexLonLat(triangleIndices[triangleStart + 1]);
    const triangleCornerC = vertexLonLat(triangleIndices[triangleStart + 2]);
    const triangleSideAB = sideOfEdge(triangleCornerA, triangleCornerB);
    const triangleSideBC = sideOfEdge(triangleCornerB, triangleCornerC);
    const triangleSideCA = sideOfEdge(triangleCornerC, triangleCornerA);
    if ((triangleSideAB >= 0 && triangleSideBC >= 0 && triangleSideCA >= 0) || (triangleSideAB <= 0 && triangleSideBC <= 0 && triangleSideCA <= 0)) return true;
  }
  return false;
}

// Dateline unwrap
{
  const datelineRing: [number, number][] = [
    [170, 10],
    [175, 10],
    [-175, 10],
    [-170, 10],
    [170, 10],
  ];
  const unwrappedRing = unwrapRingLons(datelineRing);
  assertCheck(unwrappedRing[2][0] > 180 || unwrappedRing[2][0] > unwrappedRing[1][0], "unwrapped lons monotonic across dateline");
  assertCheck(unwrappedLonSpan(unwrappedRing) < 50, "unwrapped span of short dateline arc is small");
}

// Geodesic midpoint
{
  const startEcef = lonLatToEcef(0, 0, 12);
  const endPointEcef = lonLatToEcef(0, 2, 12);
  const midPointEcef = geodesicPoint(startEcef, endPointEcef, 0.5, 12);
  const [midLongitude, midLatitude] = ecefToLonLat(midPointEcef[0], midPointEcef[1], midPointEcef[2]);
  assertCheck(Math.abs(midLongitude) < 0.5, "midpoint lon near 0");
  assertCheck(Math.abs(midLatitude - 1) < 0.15, "midpoint lat ≈ 1°");
}

// Pole enclosure
{
  const antarcticRing: [number, number][] = [];
  for (let stepIndex = 0; stepIndex <= 36; stepIndex++) antarcticRing.push([-180 + (stepIndex / 36) * 360, -80]);
  assertCheck(ringEnclosesPole(antarcticRing) === "south", "Antarctica-like ring encloses south pole");
}

// Edge split
{
  const positionData: number[] = [];
  const indexList: number[] = [];
  positionData.push(...lonLatToEcef(0, 0, 12), ...lonLatToEcef(5, 0, 12), ...lonLatToEcef(0, 5, 12));
  indexList.push(0, 1, 2);
  const { maxEdgeLength } = splitLongEdges(positionData, indexList, maxEdgeMFromOrderNum(0), 12);
  assertCheck(maxEdgeLength <= maxEdgeMFromOrderNum(0) * 1.05, `maxEdgeLength ${maxEdgeLength} ≤ budget`);
  assertCheck(indexList.length / 3 > 1, "edge split produced more triangles");
}

// Simple continent-like Africa box
{
  const africaBox = singlePolygon([
    [
      [0, 0],
      [20, 0],
      [20, 15],
      [0, 15],
      [0, 0],
    ],
  ]);
  const fullMesh = featureCollectionToMesh(africaBox, 0);
  assertCheck(fullMesh.triangleCount > 0, "simple polygon produces triangles");
  assertCheck(fullMesh.meshStats.earcutEmpty + fullMesh.meshStats.earcutThrow === 0, "no earcut failures on simple poly");
  assertCheck(
    fullMesh.meshStats.maxEdgeMObserved <= maxEdgeMFromOrderNum(0) * 1.05,
    `maxEdgeLength observed ${fullMesh.meshStats.maxEdgeMObserved}`
  );
  const clippedMesh = featureCollectionToMesh(africaBox, 0, undefined, {
    clipBounds: { westEdge: 5, southEdge: 5, eastEdge: 10, northEdge: 10 },
    cameraHeightM: 3_000_000,
  });
  assertCheck(clippedMesh.triangleCount > 0, "clip to view bbox still produces triangles");
  assertCheck(clippedMesh.triangleCount <= fullMesh.triangleCount, "clippedPolygon mesh is not larger than full polygon");
}

// Asia-like dateline spanning polygon (proper ring across ±180)
{
  const datelineMesh = featureCollectionToMesh(
    singlePolygon([
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
    ]),
    0
  );
  assertCheck(
    datelineMesh.triangleCount > 0 && datelineMesh.triangleCount < 500_000,
    `dateline polygon triangles=${datelineMesh.triangleCount} splits=${datelineMesh.meshStats.datelineSplits}`
  );
  assertCheck(datelineMesh.meshStats.earcutEmpty + datelineMesh.meshStats.earcutThrow === 0, "no earcut failures on dateline poly");
}

// Antarctica-like
{
  const antarcticRing: number[][] = [];
  for (let stepIndex = 0; stepIndex <= 24; stepIndex++) antarcticRing.push([-180 + (stepIndex / 24) * 360, -72]);
  antarcticRing.push(antarcticRing[0]);
  const antarcticMesh = featureCollectionToMesh(singlePolygon([antarcticRing]), 0);
  assertCheck(antarcticMesh.meshStats.poleHandled >= 1, "poleHandled for Antarctica-like");
  assertCheck(antarcticMesh.triangleCount > 0, "Antarctica-like has triangles");
  // No triangle centroid should be near the equator.
  let northernCount = 0;
  const positionData = antarcticMesh.positions;
  const triangleIndices = antarcticMesh.triangleIndices;
  for (let triangleStart = 0; triangleStart < triangleIndices.length; triangleStart += 3) {
    const centroidZ =
      (positionData[triangleIndices[triangleStart] * 3 + 2] +
        positionData[triangleIndices[triangleStart + 1] * 3 + 2] +
        positionData[triangleIndices[triangleStart + 2] * 3 + 2]) /
      3;
    if (centroidZ > -1e6) northernCount++;
  }
  assertCheck(northernCount === 0, "no Antarctica triangles near/north of equator");
}

// Clipping must not bridge separate pieces: a comb whose teeth are joined outside
// the view bbox (plus a lake crossing the bbox edge) must leave the gaps uncovered.
{
  const combRing = [
    [0, 0], [6, 0], [6, 1], [1, 1], [1, 2], [6, 2], [6, 3], [1, 3], [1, 4], [6, 4], [6, 5], [0, 5], [0, 0],
  ];
  const lakeRing = [[2.5, 4.2], [4, 4.2], [4, 4.8], [2.5, 4.8], [2.5, 4.2]];
  const clipBounds = { westEdge: 3, southEdge: -1, eastEdge: 8, northEdge: 6 };
  for (const [windingName, exteriorRing] of [["ccw", combRing], ["cw", [...combRing].reverse()]] as const) {
    const combMesh = featureCollectionToMesh(singlePolygon([exteriorRing as number[][], lakeRing]), 5, undefined, {
      clipBounds,
      cameraHeightM: 50_000,
    });
    assertCheck(
      isCovered(combMesh, 4.5, 0.5) && isCovered(combMesh, 4.5, 2.5) && isCovered(combMesh, 4.5, 4.1),
      `${windingName}: comb teeth are land`
    );
    assertCheck(!isCovered(combMesh, 4.5, 1.5) && !isCovered(combMesh, 4.5, 3.5), `${windingName}: water between clippedPolygon teeth stays open`);
    assertCheck(!isCovered(combMesh, 3.5, 4.5), `${windingName}: lake crossing the bbox edge stays open`);
    assertCheck(!isCovered(combMesh, 7, 2.5), `${windingName}: nothing east of the land`);
  }
}

// Plate rotations: pole rotation, slerp, chained plates, missing poles
{
  const rotatedVec = [0, 0, 0];
  quatRotate(quatFromPole(90, 0, 90), 1, 0, 0, rotatedVec); // 90° about the north pole: lon 0 → lon 90
  assertCheck(
    Math.abs(rotatedVec[0]) < 1e-12 && Math.abs(rotatedVec[1] - 1) < 1e-12 && Math.abs(rotatedVec[2]) < 1e-12,
    "pole rotation turns lon 0 to lon 90"
  );
  quatRotate(quatSlerp(quatFromPole(90, 0, 0), quatFromPole(90, 0, 90), 0.5), 1, 0, 0, rotatedVec);
  assertCheck(Math.abs(Math.atan2(rotatedVec[1], rotatedVec[0]) * (180 / Math.PI) - 45) < 1e-9, "slerp halfway gives 45°");
  const rotationTree = new RotationTree({
    maxAge: 100,
    anchorPlate: 0,
    plates: {
      // plate 1 spins 90° about the pole over 100 Myr relative to the anchor
      "1": [[0, 90, 0, 0, 0], [100, 90, 0, 90, 0]],
      // plate 2 adds another 90° relative to plate 1, but only back to 50 Ma
      "2": [[0, 90, 0, 0, 1], [50, 90, 0, 90, 1]],
    },
  });
  const longitudeAt = (plateNumber: number, ageInMyr: number) => {
    const plateQuat = rotationTree.totalRotation(plateNumber, ageInMyr);
    if (!plateQuat) return null;
    quatRotate(plateQuat, 1, 0, 0, rotatedVec);
    return Math.atan2(rotatedVec[1], rotatedVec[0]) * (180 / Math.PI);
  };
  assertCheck(Math.abs((longitudeAt(1, 50) ?? NaN) - 45) < 1e-9, "interpolated pole at 50 Ma");
  assertCheck(Math.abs((longitudeAt(2, 50) ?? NaN) - 135) < 1e-9, "chained rotation composes child after parent");
  assertCheck(longitudeAt(2, 80) === null, "missing poles in the chain hide the plate instead of snapping it home");
  assertCheck(longitudeAt(999999, 10) === null, "unknown plate has no rotation");
  assertCheck(longitudeAt(2, 0) === 0, "present day is identity");
}

console.log("\nAll land geometry / mesh / rotation self-checks passed.");
