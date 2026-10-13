/** Surface-following interpolation and ring densification on the WGS84 ellipsoid. */

import { unwrapLongitudeNear } from "../geodesy/angleMath";
import {
  ecefToGeodetic,
  lonLatToEcef,
  pointDistance,
  type LonLatPoint,
  type Vector3d,
} from "../geodesy/wgs84Ellipsoid";
import { stripClosingVertex, unwrapRingLons } from "./antimeridianSplit";

/** Radial offset of land above the ellipsoid (avoids z-fighting with the ocean). */
export const LAND_HEIGHT_M = 12;

const MAX_SUBDIVIDE_DEPTH = 14;

/**
 * Point at a fraction along the surface path between two ECEF points.
 *
 * Usage: edge midpoints during mesh refinement. Interpolates geodetic lon/lat
 * (short-arc unwrap), then converts back, so the result lies on the same
 * ellipsoid + height as the rest of the mesh.
 *
 * @param startEcef - Start point (ECEF metres).
 * @param endPointEcef - End point (ECEF metres).
 * @param fraction - Position along the path (0..1).
 * @param heightMeters - Height of the result above the ellipsoid.
 * @returns ECEF point.
 */
export function geodesicPoint(startEcef: Vector3d, endPointEcef: Vector3d, fraction: number, heightMeters = LAND_HEIGHT_M): Vector3d {
  if (fraction <= 0) return lonLatToEcef(...ecefToGeodetic(startEcef[0], startEcef[1], startEcef[2]), heightMeters);
  if (fraction >= 1) return lonLatToEcef(...ecefToGeodetic(endPointEcef[0], endPointEcef[1], endPointEcef[2]), heightMeters);
  const [startLon, startLat] = ecefToGeodetic(startEcef[0], startEcef[1], startEcef[2]);
  const [endLongitude, endLatitude] = ecefToGeodetic(endPointEcef[0], endPointEcef[1], endPointEcef[2]);
  let deltaLon = endLongitude - startLon;
  if (deltaLon > 180) deltaLon -= 360;
  if (deltaLon < -180) deltaLon += 360;
  return lonLatToEcef(startLon + fraction * deltaLon, startLat + fraction * (endLatitude - startLat), heightMeters);
}

/**
 * Linear interpolation in an already-unwrapped lon/lat frame.
 *
 * Usage: ring densification midpoints.
 *
 * @param startPoint - Point at fraction 0.
 * @param endPoint - Point at fraction 1.
 * @param fraction - Interpolation parameter.
 * @returns Interpolated point.
 */
export function interpolateLonLat(startPoint: LonLatPoint, endPoint: LonLatPoint, fraction: number): LonLatPoint {
  return [startPoint[0] + fraction * (endPoint[0] - startPoint[0]), startPoint[1] + fraction * (endPoint[1] - startPoint[1])];
}

/**
 * Densify a ring so every consecutive ECEF chord is at most maxEdgeMeters.
 *
 * Usage: before triangulation, so long coast edges do not cut through the globe.
 * Subdivides by lon/lat midpoint recursion in the unwrapped frame.
 *
 * @param ringCoords - Ring vertices (closed or open).
 * @param maxEdgeMeters - Chord budget in metres (at least 1).
 * @param heightMeters - Height used to measure chords.
 * @returns Densified open ring in a continuous longitude frame.
 */
export function densifyRingGeodesic(ringCoords: number[][], maxEdgeMeters: number, heightMeters = LAND_HEIGHT_M): LonLatPoint[] {
  const unwrappedRing = unwrapRingLons(stripClosingVertex(ringCoords));
  if (unwrappedRing.length < 2) return unwrappedRing;
  const densePoints: LonLatPoint[] = [];
  const pointCount = unwrappedRing.length;
  const edgeBudget = Math.max(maxEdgeMeters, 1);

  const subdivideEdge = (startPoint: LonLatPoint, endPoint: LonLatPoint, recursionDepth: number) => {
    const startEcef = lonLatToEcef(startPoint[0], startPoint[1], heightMeters);
    const endPointEcef = lonLatToEcef(endPoint[0], endPoint[1], heightMeters);
    if (pointDistance(startEcef, endPointEcef) <= edgeBudget || recursionDepth >= MAX_SUBDIVIDE_DEPTH) return;
    const midPoint = interpolateLonLat(startPoint, endPoint, 0.5);
    subdivideEdge(startPoint, midPoint, recursionDepth + 1);
    densePoints.push(midPoint);
    subdivideEdge(midPoint, endPoint, recursionDepth + 1);
  };

  for (let pointIdx = 0; pointIdx < pointCount; pointIdx++) {
    const startPoint = unwrappedRing[pointIdx];
    const rawEndPoint = unwrappedRing[(pointIdx + 1) % pointCount];
    const endPoint: LonLatPoint = [unwrapLongitudeNear(rawEndPoint[0], startPoint[0]), rawEndPoint[1]];
    densePoints.push([startPoint[0], startPoint[1]]);
    subdivideEdge(startPoint, endPoint, 0);
  }
  return densePoints;
}
