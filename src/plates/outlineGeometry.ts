/**
 * Ring geometry of plate outlines on the GPlates sphere: line segments for the
 * wireframe and a label anchor per polygon.
 *
 * Everything works on unit vectors, so rings crossing the antimeridian need no
 * special handling; only the artificial cut edges that GIS tools add along ±180°
 * longitude and at the poles are left out of the wireframe.
 */

import { lonLatToUnit, type UnitVector } from "./sphericalCoords";
import { arcAngle, pointAlongArc } from "./unitVectorMath";

/** Longer edges are split so the line follows the sphere instead of cutting under it. */
const MAX_SEGMENT_DEG = 1;
const SEAM_LONGITUDE_DEG = 179.99;
const POLE_LATITUDE_DEG = 89.99;
const RAD_TO_DEG = 180 / Math.PI;

/** Label anchor of one polygon: direction of its centroid and a size weight. */
export type RingCentroid = { centroidUnit: UnitVector; sizeWeight: number };

/**
 * Whether an edge is an artificial cut (both ends on the antimeridian or both at a pole).
 *
 * Usage: skip such edges when drawing outlines; they are not plate boundaries.
 *
 * @param startPoint - [lon°, lat°] of the first vertex.
 * @param endPoint - [lon°, lat°] of the second vertex.
 * @returns True for a seam edge.
 */
export function isSeamEdge(startPoint: number[], endPoint: number[]): boolean {
  const onAntimeridian = Math.abs(startPoint[0]) >= SEAM_LONGITUDE_DEG && Math.abs(endPoint[0]) >= SEAM_LONGITUDE_DEG;
  const atSamePole =
    Math.abs(startPoint[1]) >= POLE_LATITUDE_DEG &&
    Math.abs(endPoint[1]) >= POLE_LATITUDE_DEG &&
    Math.sign(startPoint[1]) === Math.sign(endPoint[1]);
  return onAntimeridian || atSamePole;
}

/**
 * Append one edge as GL_LINES vertex pairs, split into pieces of at most 1°.
 *
 * Usage: per drawable ring edge, and every line drawn by the plate-boundary layers.
 *
 * @param startUnit - Edge start.
 * @param arcEndUnit - Edge end.
 * @param segmentValues - Flat xyz list extended in place (two vertices per piece).
 * @returns Nothing.
 */
export function appendEdgeSegments(startUnit: UnitVector, arcEndUnit: UnitVector, segmentValues: number[]): void {
  const edgeAngleDeg = arcAngle(startUnit, arcEndUnit) * RAD_TO_DEG;
  if (edgeAngleDeg <= 0) return;
  const pieceCount = Math.max(1, Math.ceil(edgeAngleDeg / MAX_SEGMENT_DEG));
  let pieceStart = startUnit;
  for (let pieceIdx = 1; pieceIdx <= pieceCount; pieceIdx++) {
    const pieceEnd = pieceIdx === pieceCount ? arcEndUnit : pointAlongArc(startUnit, arcEndUnit, pieceIdx / pieceCount);
    segmentValues.push(pieceStart[0], pieceStart[1], pieceStart[2], pieceEnd[0], pieceEnd[1], pieceEnd[2]);
    pieceStart = pieceEnd;
  }
}

/**
 * Append the drawable edges of a ring as GL_LINES vertex pairs.
 *
 * Usage: every exterior and hole ring of an outline polygon.
 *
 * @param ringCoords - Closed or open ring of [lon°, lat°] points.
 * @param segmentValues - Flat xyz list extended in place.
 * @returns Nothing; seam edges and zero-length edges add nothing.
 */
export function appendRingSegments(ringCoords: number[][], segmentValues: number[]): void {
  for (let pointIdx = 1; pointIdx < ringCoords.length; pointIdx++) {
    const startPoint = ringCoords[pointIdx - 1];
    const endPoint = ringCoords[pointIdx];
    if (isSeamEdge(startPoint, endPoint)) continue;
    appendEdgeSegments(lonLatToUnit(startPoint[0], startPoint[1]), lonLatToUnit(endPoint[0], endPoint[1]), segmentValues);
  }
}

/**
 * Centroid direction and size of the region enclosed by a ring.
 *
 * Usage: label anchor of an outline polygon. By Stokes' theorem the integral of the
 * surface normal over the region is ½ Σ θ·(a×b)/|a×b| over its great-circle edges;
 * its direction is the centroid and its length grows with the area. The sign is
 * chosen so the centroid lies on the ring's side of the sphere, which makes the
 * result independent of the ring's winding.
 *
 * @param ringCoords - Closed ring of [lon°, lat°] points.
 * @returns Centroid unit vector and size weight (≈ area in steradians for small rings),
 *   or null for degenerate rings.
 */
export function ringCentroid(ringCoords: number[][]): RingCentroid | null {
  const momentSum = [0, 0, 0];
  const vertexSum = [0, 0, 0];
  for (let pointIdx = 1; pointIdx < ringCoords.length; pointIdx++) {
    const startUnit = lonLatToUnit(ringCoords[pointIdx - 1][0], ringCoords[pointIdx - 1][1]);
    const arcEndUnit = lonLatToUnit(ringCoords[pointIdx][0], ringCoords[pointIdx][1]);
    const crossVecX = startUnit[1] * arcEndUnit[2] - startUnit[2] * arcEndUnit[1];
    const crossVecY = startUnit[2] * arcEndUnit[0] - startUnit[0] * arcEndUnit[2];
    const crossVecZ = startUnit[0] * arcEndUnit[1] - startUnit[1] * arcEndUnit[0];
    const crossLength = Math.hypot(crossVecX, crossVecY, crossVecZ);
    for (let axisIndex = 0; axisIndex < 3; axisIndex++) vertexSum[axisIndex] += startUnit[axisIndex];
    if (crossLength < 1e-15) continue;
    const edgeWeight = (0.5 * arcAngle(startUnit, arcEndUnit)) / crossLength;
    momentSum[0] += crossVecX * edgeWeight;
    momentSum[1] += crossVecY * edgeWeight;
    momentSum[2] += crossVecZ * edgeWeight;
  }
  const momentLength = Math.hypot(momentSum[0], momentSum[1], momentSum[2]);
  if (momentLength < 1e-12) return null;
  const sideSign = momentSum[0] * vertexSum[0] + momentSum[1] * vertexSum[1] + momentSum[2] * vertexSum[2] < 0 ? -1 : 1;
  const scaleFactor = sideSign / momentLength;
  return {
    centroidUnit: [momentSum[0] * scaleFactor, momentSum[1] * scaleFactor, momentSum[2] * scaleFactor],
    sizeWeight: momentLength,
  };
}
