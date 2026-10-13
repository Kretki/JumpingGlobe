/** Planar (lon/lat) ring helpers used while preparing polygons for triangulation. */

import { unwrapLongitudeNear } from "../geodesy/angleMath";
import type { LonLatPoint } from "../geodesy/wgs84Ellipsoid";

const VERTEX_EPSILON = 1e-12;

/**
 * Remove consecutive duplicate vertices and a closing vertex equal to the first.
 *
 * Usage: clean rings before triangulation or clipping.
 *
 * @param ringPoints - Ring vertices.
 * @returns New array without repeated points (vertex objects are shared, not copied).
 */
export function dedupeVertices(ringPoints: LonLatPoint[]): LonLatPoint[] {
  const dedupedPoints: LonLatPoint[] = [];
  for (const ringPoint of ringPoints) {
    const lastPoint = dedupedPoints[dedupedPoints.length - 1];
    if (
      !lastPoint ||
      Math.abs(lastPoint[0] - ringPoint[0]) > VERTEX_EPSILON ||
      Math.abs(lastPoint[1] - ringPoint[1]) > VERTEX_EPSILON
    ) {
      dedupedPoints.push(ringPoint);
    }
  }
  const pointCount = dedupedPoints.length;
  if (
    pointCount > 1 &&
    Math.abs(dedupedPoints[0][0] - dedupedPoints[pointCount - 1][0]) < VERTEX_EPSILON &&
    Math.abs(dedupedPoints[0][1] - dedupedPoints[pointCount - 1][1]) < VERTEX_EPSILON
  ) {
    dedupedPoints.pop();
  }
  return dedupedPoints;
}

/**
 * Drop vertices lying on the straight lon/lat segment between their neighbours
 * (e.g. produced by ogr2ogr -segmentize).
 *
 * Usage: lossless for the shape; the mesher re-densifies geodesically to the LOD
 * budget, so these vertices would only cost earcut slivers.
 *
 * @param ringPoints - Ring vertices (open ring).
 * @param toleranceDeg - Maximum perpendicular deviation in degrees.
 * @returns Simplified ring, or the input when fewer than 3 vertices would remain.
 */
export function dropCollinearVertices(ringPoints: LonLatPoint[], toleranceDeg = 1e-7): LonLatPoint[] {
  if (ringPoints.length < 4) return ringPoints;
  const keptPoints: LonLatPoint[] = [ringPoints[0]];
  for (let pointIdx = 1; pointIdx < ringPoints.length; pointIdx++) {
    const candidate = ringPoints[pointIdx];
    while (keptPoints.length >= 2) {
      const anchorPoint = keptPoints[keptPoints.length - 2];
      const middlePoint = keptPoints[keptPoints.length - 1];
      const middleDx = unwrapLongitudeNear(middlePoint[0], anchorPoint[0]) - anchorPoint[0];
      const middleDy = middlePoint[1] - anchorPoint[1];
      const candidateDx = unwrapLongitudeNear(candidate[0], anchorPoint[0]) - anchorPoint[0];
      const candidateDy = candidate[1] - anchorPoint[1];
      const lengthSquared = candidateDx * candidateDx + candidateDy * candidateDy;
      if (lengthSquared < 1e-24) break;
      const dotProduct = middleDx * candidateDx + middleDy * candidateDy;
      const crossProduct = middleDx * candidateDy - middleDy * candidateDx;
      const isOnSegment = dotProduct > 0 && dotProduct < lengthSquared;
      if (isOnSegment && crossProduct * crossProduct <= toleranceDeg * toleranceDeg * lengthSquared) keptPoints.pop();
      else break;
    }
    keptPoints.push(candidate);
  }
  return keptPoints.length >= 3 ? keptPoints : ringPoints;
}

/**
 * Even–odd point-in-ring test in the plane.
 *
 * Usage: hole assignment and inside/outside checks during clipping.
 *
 * @param testPointX - Test point x (longitude).
 * @param testPointY - Test point y (latitude).
 * @param ringPoints - Ring vertices (open or closed).
 * @returns True when the point is inside.
 */
export function pointInRing(testPointX: number, testPointY: number, ringPoints: [number, number][]): boolean {
  let isInside = false;
  for (let currentIdx = 0, previousIdx = ringPoints.length - 1; currentIdx < ringPoints.length; previousIdx = currentIdx++) {
    const currentX = ringPoints[currentIdx][0];
    const currentY = ringPoints[currentIdx][1];
    const previousX = ringPoints[previousIdx][0];
    const previousY = ringPoints[previousIdx][1];
    const deltaAlongY = previousY - currentY;
    if (currentY > testPointY !== previousY > testPointY && Math.abs(deltaAlongY) > 1e-18) {
      if (testPointX < ((previousX - currentX) * (testPointY - currentY)) / deltaAlongY + currentX) isInside = !isInside;
    }
  }
  return isInside;
}

/**
 * Linear interpolation between two lon/lat points.
 *
 * Usage: boundary crossings while clipping.
 *
 * @param startPoint - Point at fraction 0.
 * @param endPoint - Point at fraction 1.
 * @param fraction - Interpolation parameter.
 * @returns The interpolated point (new array).
 */
export function lerpLonLat(startPoint: LonLatPoint, endPoint: LonLatPoint, fraction: number): LonLatPoint {
  return [
    startPoint[0] + (endPoint[0] - startPoint[0]) * fraction,
    startPoint[1] + (endPoint[1] - startPoint[1]) * fraction,
  ];
}

/**
 * Signed shoelace area of a lon/lat ring.
 *
 * Usage: orientation tests (positive = counter-clockwise).
 *
 * @param ringPoints - Ring vertices.
 * @returns Signed area in deg².
 */
export function ringSignedArea(ringPoints: LonLatPoint[]): number {
  let doubledArea = 0;
  for (let currentIdx = 0, previousIdx = ringPoints.length - 1; currentIdx < ringPoints.length; previousIdx = currentIdx++) {
    doubledArea +=
      ringPoints[previousIdx][0] * ringPoints[currentIdx][1] - ringPoints[currentIdx][0] * ringPoints[previousIdx][1];
  }
  return doubledArea / 2;
}

/**
 * Subsample a ring to at most a vertex budget (safety cap only).
 *
 * Usage: guard against pathological inputs; never triggers for real data.
 *
 * @param ringPoints - Ring vertices.
 * @param maxVertices - Vertex budget.
 * @returns The ring unchanged, or an evenly index-subsampled copy.
 */
export function capRingVertices(ringPoints: LonLatPoint[], maxVertices: number): LonLatPoint[] {
  if (ringPoints.length <= maxVertices) return ringPoints;
  const sampledPoints: LonLatPoint[] = [];
  const pointCount = ringPoints.length;
  for (let sampleIdx = 0; sampleIdx < maxVertices; sampleIdx++) {
    sampledPoints.push(ringPoints[Math.floor((sampleIdx * pointCount) / maxVertices)]);
  }
  return dedupeVertices(sampledPoints);
}
