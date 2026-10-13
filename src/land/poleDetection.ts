/** Detect rings that enclose a geographic pole (they need a polar chart or a polar cap mesh). */

import { unwrapLongitudeNear } from "../geodesy/angleMath";
import type { LonLatPoint } from "../geodesy/wgs84Ellipsoid";
import { stripClosingVertex, unwrapRingLons, unwrappedLonSpan } from "./antimeridianSplit";

export const POLE_LAT_DEG = 89.999;

/** Which pole a ring encloses, if any. */
export type PoleKind = "north" | "south" | null;

/**
 * Orientation of a point relative to the directed line start→end.
 *
 * Usage: winding-number computation.
 *
 * @param startPoint - Line start.
 * @param endPoint - Line end.
 * @param longitudeDeg - Test point x.
 * @param latitudeDeg - Test point y.
 * @returns > 0 left of the line, < 0 right, 0 on it.
 */
function sideOfLine(startPoint: LonLatPoint, endPoint: LonLatPoint, longitudeDeg: number, latitudeDeg: number): number {
  return (
    (endPoint[0] - startPoint[0]) * (latitudeDeg - startPoint[1]) -
    (longitudeDeg - startPoint[0]) * (endPoint[1] - startPoint[1])
  );
}

/**
 * 2D winding number of an unwrapped ring around a point.
 *
 * Usage: pole enclosure test.
 *
 * @param ringPoints - Unwrapped ring.
 * @param longitudeDeg - Point longitude.
 * @param latitudeDeg - Point latitude.
 * @returns Winding number (0 = outside).
 */
export function windingNumber(ringPoints: LonLatPoint[], longitudeDeg: number, latitudeDeg: number): number {
  let windCount = 0;
  const pointCount = ringPoints.length;
  for (let pointIdx = 0; pointIdx < pointCount; pointIdx++) {
    const startPoint = ringPoints[pointIdx];
    const endPoint = ringPoints[(pointIdx + 1) % pointCount];
    if (startPoint[1] <= latitudeDeg) {
      if (endPoint[1] > latitudeDeg && sideOfLine(startPoint, endPoint, longitudeDeg, latitudeDeg) > 0) windCount++;
    } else if (endPoint[1] <= latitudeDeg && sideOfLine(startPoint, endPoint, longitudeDeg, latitudeDeg) < 0) {
      windCount--;
    }
  }
  return windCount;
}

/**
 * Detect whether a ring encloses the north or south pole.
 *
 * Usage: choose polar handling for Antarctica-like rings.
 *
 * @param ringCoords - Ring vertices (closed or open).
 * @returns "north", "south" or null.
 */
export function ringEnclosesPole(ringCoords: number[][]): PoleKind {
  const unwrappedRing = unwrapRingLons(stripClosingVertex(ringCoords));
  if (unwrappedRing.length < 3) return null;

  let minLatitude = 90;
  let maxLatitude = -90;
  let meanLongitude = 0;
  for (const ringPoint of unwrappedRing) {
    minLatitude = Math.min(minLatitude, ringPoint[1]);
    maxLatitude = Math.max(maxLatitude, ringPoint[1]);
    meanLongitude += ringPoint[0];
  }
  meanLongitude /= unwrappedRing.length;
  const lonSpanDeg = unwrappedLonSpan(unwrappedRing);

  // Full-longitude polar caps (constant-lat coasts) — span heuristic first.
  if (lonSpanDeg > 270) {
    if (maxLatitude > 70 && minLatitude > 0) return "north";
    if (minLatitude < -70 && maxLatitude < 0) return "south";
    if (maxLatitude > 85) return "north";
    if (minLatitude < -85) return "south";
  }

  // Continuous closing edge for winding (avoid the ±180 jump).
  const closingLon = unwrapLongitudeNear(unwrappedRing[0][0], unwrappedRing[unwrappedRing.length - 1][0]);
  const closedRing: LonLatPoint[] = unwrappedRing.concat([[closingLon, unwrappedRing[0][1]]]);

  if (windingNumber(closedRing, meanLongitude, POLE_LAT_DEG) !== 0) return "north";
  if (windingNumber(closedRing, meanLongitude, -POLE_LAT_DEG) !== 0) return "south";
  return null;
}
