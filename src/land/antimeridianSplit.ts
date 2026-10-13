/** Unwrap rings into a continuous longitude frame and split them at 180°-wide windows. */

import { unwrapLongitudeNear } from "../geodesy/angleMath";
import type { LonLatPoint } from "../geodesy/wgs84Ellipsoid";
import { dedupeVertices } from "./ringGeometry";

export const ANTIMERIDIAN_EPS_DEG = 1e-9;

/**
 * Copy a GeoJSON ring as lon/lat points without its closing vertex.
 *
 * Usage: first step for every input ring.
 *
 * @param ringCoords - GeoJSON ring (closed or open).
 * @returns Open ring of [lon, lat] points.
 */
export function stripClosingVertex(ringCoords: number[][]): LonLatPoint[] {
  if (ringCoords.length < 2) return ringCoords.map((coordPair) => [coordPair[0], coordPair[1]] as LonLatPoint);
  const firstPoint = ringCoords[0];
  const lastPoint = ringCoords[ringCoords.length - 1];
  const openRing =
    firstPoint[0] === lastPoint[0] && firstPoint[1] === lastPoint[1] ? ringCoords.slice(0, -1) : ringCoords.slice();
  return openRing.map((coordPair) => [coordPair[0], coordPair[1]] as LonLatPoint);
}

/**
 * Unwrap a ring into a continuous longitude frame (longitudes may leave [-180, 180]).
 *
 * Usage: before span measurements and planar operations on dateline-crossing rings.
 *
 * @param ringCoords - Ring vertices.
 * @returns New ring where consecutive longitudes differ by at most 180°.
 */
export function unwrapRingLons(ringCoords: number[][]): LonLatPoint[] {
  if (ringCoords.length === 0) return [];
  const unwrappedRing: LonLatPoint[] = [[ringCoords[0][0], ringCoords[0][1]]];
  for (let pointIdx = 1; pointIdx < ringCoords.length; pointIdx++) {
    const longitudeDeg = unwrapLongitudeNear(ringCoords[pointIdx][0], unwrappedRing[pointIdx - 1][0]);
    unwrappedRing.push([longitudeDeg, ringCoords[pointIdx][1]]);
  }
  return unwrappedRing;
}

/**
 * Longitudinal extent of an already-unwrapped ring.
 *
 * Usage: detect rings wider than 180° that must be split.
 *
 * @param ringPoints - Unwrapped ring.
 * @returns max(lon) − min(lon) in degrees (0 for an empty ring).
 */
export function unwrappedLonSpan(ringPoints: LonLatPoint[]): number {
  if (!ringPoints.length) return 0;
  let minLongitude = ringPoints[0][0];
  let maxLongitude = ringPoints[0][0];
  for (let pointIdx = 1; pointIdx < ringPoints.length; pointIdx++) {
    minLongitude = Math.min(minLongitude, ringPoints[pointIdx][0]);
    maxLongitude = Math.max(maxLongitude, ringPoints[pointIdx][0]);
  }
  return maxLongitude - minLongitude;
}

/**
 * Point where segment start→end crosses a meridian (linear in lon/lat).
 *
 * Usage: Sutherland–Hodgman clipping against a longitude.
 *
 * @param startPoint - Segment start.
 * @param endPoint - Segment end.
 * @param targetLon - Meridian longitude.
 * @returns [targetLon, interpolated latitude].
 */
export function interpolateAtLon(startPoint: LonLatPoint, endPoint: LonLatPoint, targetLon: number): LonLatPoint {
  const deltaLon = endPoint[0] - startPoint[0];
  if (Math.abs(deltaLon) < ANTIMERIDIAN_EPS_DEG) return [targetLon, (startPoint[1] + endPoint[1]) / 2];
  const fraction = (targetLon - startPoint[0]) / deltaLon;
  return [targetLon, startPoint[1] + fraction * (endPoint[1] - startPoint[1])];
}

/**
 * Clip a ring to one side of a meridian (Sutherland–Hodgman, one plane).
 *
 * Usage: building block of clipRingLon.
 *
 * @param inputRing - Unwrapped ring.
 * @param boundaryLon - Meridian longitude.
 * @param keepEast - True keeps lon >= boundaryLon, false keeps lon <= boundaryLon.
 * @returns Clipped ring (may be empty).
 */
function clipRingHalfPlane(inputRing: LonLatPoint[], boundaryLon: number, keepEast: boolean): LonLatPoint[] {
  const isPointKept = (ringPoint: LonLatPoint) =>
    keepEast ? ringPoint[0] >= boundaryLon - ANTIMERIDIAN_EPS_DEG : ringPoint[0] <= boundaryLon + ANTIMERIDIAN_EPS_DEG;
  const clippedRing: LonLatPoint[] = [];
  for (let pointIdx = 0; pointIdx < inputRing.length; pointIdx++) {
    const currentPoint = inputRing[pointIdx];
    const previousPoint = inputRing[(pointIdx + inputRing.length - 1) % inputRing.length];
    const currentKept = isPointKept(currentPoint);
    const previousKept = isPointKept(previousPoint);
    if (currentKept) {
      if (!previousKept) clippedRing.push(interpolateAtLon(previousPoint, currentPoint, boundaryLon));
      clippedRing.push(currentPoint);
    } else if (previousKept) {
      clippedRing.push(interpolateAtLon(previousPoint, currentPoint, boundaryLon));
    }
  }
  return clippedRing;
}

/**
 * Clip an unwrapped ring to the longitude band [lonLowerBound, lonUpperBound].
 *
 * Usage: cut wide rings into 180° windows.
 *
 * @param ringPoints - Unwrapped ring.
 * @param lonLowerBound - Western band edge.
 * @param lonUpperBound - Eastern band edge.
 * @returns Clipped ring (may be empty).
 */
function clipRingLon(ringPoints: LonLatPoint[], lonLowerBound: number, lonUpperBound: number): LonLatPoint[] {
  return clipRingHalfPlane(clipRingHalfPlane(ringPoints.slice(), lonLowerBound, true), lonUpperBound, false);
}

/**
 * Split a ring into pieces whose longitude span is at most 180°.
 *
 * Usage: rings spanning more than 180° cannot be charted with one ENU frame.
 *
 * @param ringCoords - Ring vertices (closed or open).
 * @returns Unwrapped rings suitable for ENU earcut; the whole ring when no split is needed.
 */
export function splitRingAntimeridian(ringCoords: number[][]): LonLatPoint[][] {
  const unwrappedRing = unwrapRingLons(stripClosingVertex(ringCoords));
  if (unwrappedRing.length < 3) return [];

  let minLongitude = unwrappedRing[0][0];
  let maxLongitude = unwrappedRing[0][0];
  for (const ringPoint of unwrappedRing) {
    minLongitude = Math.min(minLongitude, ringPoint[0]);
    maxLongitude = Math.max(maxLongitude, ringPoint[0]);
  }
  if (maxLongitude - minLongitude <= 180 + ANTIMERIDIAN_EPS_DEG) return [unwrappedRing];

  const splitRings: LonLatPoint[][] = [];
  for (let windowWest = minLongitude; windowWest < maxLongitude - ANTIMERIDIAN_EPS_DEG; windowWest += 180) {
    const cleanedRing = dedupeVertices(clipRingLon(unwrappedRing, windowWest, windowWest + 180));
    if (cleanedRing.length >= 3) splitRings.push(cleanedRing);
  }
  return splitRings.length ? splitRings : [unwrappedRing];
}
