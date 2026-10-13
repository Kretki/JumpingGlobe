/** Triangulate one polygon piece: densify, chart to 2D, earcut (or polar cap mesh). */

import earcut from "earcut";
import type { LonLatPoint } from "../geodesy/wgs84Ellipsoid";
import { makeChart, projectToChart, signedArea2D, type PlaneChart } from "./chartProjection";
import { densifyRingGeodesic } from "./geodesicDensify";
import { noteDegenerate, noteReason, type MeshStats, type TriangulatedPiece } from "./meshTypes";
import { meshPolarCap } from "./polarCapMesh";
import type { PoleKind } from "./poleDetection";
import { dedupeVertices } from "./ringGeometry";

const MIN_CHART_AREA = 1e-6;

/** Charted rings in earcut's input layout. */
type ChartedRings = { vertexLonLats: LonLatPoint[]; planePoints: [number, number][]; holeStarts: number[] };

/**
 * Append a ring to the charted rings, oriented CCW (exterior) or CW (hole).
 *
 * Usage: build earcut input ring by ring.
 *
 * @param chartedRings - Accumulated vertices; modified in place.
 * @param ringPoints - Ring vertices.
 * @param planeChart - Chart to project with.
 * @param isHoleRing - Whether the ring is a hole.
 * @returns Nothing.
 */
function appendChartedRing(chartedRings: ChartedRings, ringPoints: LonLatPoint[], planeChart: PlaneChart, isHoleRing: boolean): void {
  const localPoints: [number, number][] = [];
  for (const ringPoint of ringPoints) localPoints.push(projectToChart(ringPoint[0], ringPoint[1], planeChart));
  const ringArea = signedArea2D(localPoints);
  const needsReverse = isHoleRing ? ringArea > 0 : ringArea < 0;
  const orderedRing = needsReverse ? ringPoints.slice().reverse() : ringPoints;
  const orderedPlane = needsReverse ? localPoints.slice().reverse() : localPoints;
  if (isHoleRing) chartedRings.holeStarts.push(chartedRings.vertexLonLats.length);
  for (let pointIdx = 0; pointIdx < orderedRing.length; pointIdx++) {
    chartedRings.vertexLonLats.push(orderedRing[pointIdx]);
    chartedRings.planePoints.push(orderedPlane[pointIdx]);
  }
}

/**
 * Run earcut on charted rings, recording failures.
 *
 * Usage: final step of triangulatePiece for non-polar pieces.
 *
 * @param chartedRings - Earcut input.
 * @param meshStats - Statistics to update.
 * @returns Triangle index list, or null when earcut throws or returns nothing.
 */
function runEarcut(chartedRings: ChartedRings, meshStats: MeshStats): number[] | null {
  const flatCoords: number[] = [];
  for (const planePoint of chartedRings.planePoints) flatCoords.push(planePoint[0], planePoint[1]);
  let triangleList: number[];
  try {
    triangleList = earcut(flatCoords, chartedRings.holeStarts.length ? chartedRings.holeStarts : undefined, 2);
  } catch {
    meshStats.earcutThrow++;
    noteReason(meshStats, "earcut_throw");
    return null;
  }
  if (!triangleList.length) {
    meshStats.earcutEmpty++;
    noteReason(meshStats, "earcut_empty");
    return null;
  }
  return triangleList;
}

/**
 * Triangulate a polygon piece.
 *
 * Usage: per piece before edge refinement. Only very long edges (2× the boundary
 * budget) are pre-densified so earcut stays well-conditioned without a dense
 * skinny-triangle soup; final spacing comes from splitLongEdges.
 *
 * @param exteriorRing - Exterior ring.
 * @param holeRings - Hole rings.
 * @param poleKind - Pole enclosed by the exterior.
 * @param boundaryMaxMeters - Boundary edge budget of the LOD.
 * @param meshStats - Statistics to update.
 * @returns Vertices and triangles, or null when the piece cannot be triangulated.
 */
export function triangulatePiece(
  exteriorRing: LonLatPoint[],
  holeRings: LonLatPoint[][],
  poleKind: PoleKind,
  boundaryMaxMeters: number,
  meshStats: MeshStats
): TriangulatedPiece | null {
  const preDensifyMax = Math.max(boundaryMaxMeters * 2, boundaryMaxMeters);
  const denseExterior = dedupeVertices(densifyRingGeodesic(exteriorRing, preDensifyMax));
  const denseHoles = holeRings.map((holeRing) => densifyRingGeodesic(holeRing, preDensifyMax));
  if (denseExterior.length < 3) {
    noteDegenerate(meshStats);
    return null;
  }
  if (poleKind === "north" || poleKind === "south") {
    return meshPolarCap(denseExterior, poleKind, boundaryMaxMeters, meshStats);
  }

  const planeChart = makeChart(denseExterior, poleKind);
  const chartedRings: ChartedRings = { vertexLonLats: [], planePoints: [], holeStarts: [] };
  appendChartedRing(chartedRings, denseExterior, planeChart, false);
  for (const denseHole of denseHoles) {
    const uniqueHole = dedupeVertices(denseHole);
    if (uniqueHole.length >= 3) appendChartedRing(chartedRings, uniqueHole, planeChart, true);
  }
  if (chartedRings.vertexLonLats.length < 3) {
    noteDegenerate(meshStats);
    return null;
  }

  const exteriorCount = chartedRings.holeStarts.length ? chartedRings.holeStarts[0] : chartedRings.planePoints.length;
  if (Math.abs(signedArea2D(chartedRings.planePoints.slice(0, exteriorCount))) < MIN_CHART_AREA) {
    meshStats.zeroChartArea++;
    noteReason(meshStats, "zero_chart_area");
    return null;
  }

  const triangleList = runEarcut(chartedRings, meshStats);
  return triangleList ? { vertexLonLats: chartedRings.vertexLonLats, triangleList } : null;
}
