/** How much ground the camera sees: footprint radius and the lon/lat box around it. */

import { clampValue, wrapLongitude } from "../geodesy/angleMath";
import type { BoundingBox } from "./boundingBox";

/** Polar radius: the smallest radius gives the largest (safe) footprint. */
const POLAR_RADIUS_M = 6_356_752;
const DATA_LAT_LIMIT = 85;

/** Default angle (rad) between the view axis and a screen corner: 45° FOV, 16:9. */
export const DEFAULT_VIEW_HALF_ANGLE = Math.atan(Math.tan(Math.PI / 8) * Math.hypot(1, 16 / 9));

/**
 * Angle between the view axis and a screen corner.
 *
 * Usage: footprint of the current viewport.
 *
 * @param fieldOfViewY - Vertical field of view in radians.
 * @param aspectRatio - Viewport width / height.
 * @returns Half angle in radians.
 */
export function viewHalfAngle(fieldOfViewY: number, aspectRatio: number): number {
  return Math.atan(Math.tan(fieldOfViewY / 2) * Math.hypot(1, aspectRatio));
}

/**
 * Angular radius of the ground visible looking straight down.
 *
 * Usage: size of detail requests. Falls back to the horizon when corner rays miss the globe.
 *
 * @param heightMeters - Camera height above the surface.
 * @param halfAngleRad - Screen-corner half angle.
 * @returns Great-circle radius from the nadir point, in degrees.
 */
export function visibleGroundRadiusDeg(heightMeters: number, halfAngleRad: number): number {
  const cameraRadius = POLAR_RADIUS_M + Math.max(heightMeters, 1);
  const sineTerm = (cameraRadius / POLAR_RADIUS_M) * Math.sin(halfAngleRad);
  const radiusRad = sineTerm >= 1 ? Math.acos(POLAR_RADIUS_M / cameraRadius) : Math.asin(sineTerm) - halfAngleRad;
  return (radiusRad * 180) / Math.PI;
}

/**
 * Lon/lat box enclosing the visible ground cap (radius × padScale) around the nadir point.
 *
 * Usage: detail request box; it always covers the whole screen, so detail
 * meshes never end inside the viewport.
 *
 * @param longitudeDeg - Nadir longitude.
 * @param latitudeDeg - Nadir latitude.
 * @param heightMeters - Camera height.
 * @param halfAngleRad - Screen-corner half angle.
 * @param padScale - Multiplier on the footprint radius.
 * @returns Box clamped to ±85° latitude; spans all longitudes when the cap reaches a pole.
 */
export function viewBounds(
  longitudeDeg: number,
  latitudeDeg: number,
  heightMeters: number,
  halfAngleRad = DEFAULT_VIEW_HALF_ANGLE,
  padScale = 1.25
): BoundingBox {
  const capRadiusDeg = Math.min(90, visibleGroundRadiusDeg(heightMeters, halfAngleRad) * padScale + 0.01);
  const southEdge = clampValue(latitudeDeg - capRadiusDeg, -DATA_LAT_LIMIT, DATA_LAT_LIMIT);
  const northEdge = clampValue(latitudeDeg + capRadiusDeg, -DATA_LAT_LIMIT, DATA_LAT_LIMIT);

  // Cap touches a pole (or the ±85° data limit): it spans every longitude.
  const cosLatitude = Math.cos((latitudeDeg * Math.PI) / 180);
  const sinCapRadius = Math.sin((capRadiusDeg * Math.PI) / 180);
  if (latitudeDeg + capRadiusDeg >= DATA_LAT_LIMIT || latitudeDeg - capRadiusDeg <= -DATA_LAT_LIMIT || sinCapRadius >= cosLatitude) {
    return { westEdge: -180, southEdge, eastEdge: 180, northEdge };
  }
  const halfLonSpan = (Math.asin(sinCapRadius / cosLatitude) * 180) / Math.PI;
  if (halfLonSpan >= 179.5) return { westEdge: -180, southEdge, eastEdge: 180, northEdge };

  return {
    westEdge: wrapLongitude(longitudeDeg - halfLonSpan),
    southEdge,
    eastEdge: wrapLongitude(longitudeDeg + halfLonSpan),
    northEdge,
  };
}
