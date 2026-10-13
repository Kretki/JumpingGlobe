/** Lon/lat ↔ unit vector on the GPlates sphere (geodetic lon/lat treated as spherical). */

/** Unit vector [x, y, z], z towards the north pole. */
export type UnitVector = [number, number, number];

const DEG_TO_RAD = Math.PI / 180;

/**
 * Unit vector of a lon/lat point.
 *
 * Usage: before rotating a point with a quaternion.
 *
 * @param longitudeDeg - Longitude in degrees.
 * @param latitudeDeg - Latitude in degrees.
 * @returns Unit vector.
 */
export function lonLatToUnit(longitudeDeg: number, latitudeDeg: number): UnitVector {
  const latitudeRad = latitudeDeg * DEG_TO_RAD;
  const longitudeRad = longitudeDeg * DEG_TO_RAD;
  return [Math.cos(latitudeRad) * Math.cos(longitudeRad), Math.cos(latitudeRad) * Math.sin(longitudeRad), Math.sin(latitudeRad)];
}

/**
 * Lon/lat of a unit vector.
 *
 * Usage: read rotated positions.
 *
 * @param unitVector - Unit vector (z is clamped to [-1, 1]).
 * @returns [longitude°, latitude°].
 */
export function unitToLonLat(unitVector: ArrayLike<number>): [number, number] {
  return [
    Math.atan2(unitVector[1], unitVector[0]) / DEG_TO_RAD,
    Math.asin(Math.max(-1, Math.min(1, unitVector[2]))) / DEG_TO_RAD,
  ];
}

/**
 * Great-circle angle between two lon/lat points.
 *
 * Usage: whether the view centre is still inside a loaded cap.
 *
 * @param firstLon - First point longitude.
 * @param firstLat - First point latitude.
 * @param secondLon - Second point longitude.
 * @param secondLat - Second point latitude.
 * @returns Angle in degrees.
 */
export function angularDistanceDeg(firstLon: number, firstLat: number, secondLon: number, secondLat: number): number {
  const firstUnit = lonLatToUnit(firstLon, firstLat);
  const secondUnit = lonLatToUnit(secondLon, secondLat);
  const dotProduct = firstUnit[0] * secondUnit[0] + firstUnit[1] * secondUnit[1] + firstUnit[2] * secondUnit[2];
  return (Math.acos(Math.max(-1, Math.min(1, dotProduct))) * 180) / Math.PI;
}
