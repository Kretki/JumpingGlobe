/** WGS84 ellipsoid constants and ECEF ↔ geodetic conversions (metres, Z = north pole). */

/** Cartesian vector [x, y, z]. */
export type Vector3d = [number, number, number];
/** Geographic point [longitude°, latitude°]. */
export type LonLatPoint = [number, number];

export const WGS84_SEMI_MAJOR = 6378137.0;
export const WGS84_FLATTENING = 1 / 298.257223563;
export const WGS84_SEMI_MINOR = WGS84_SEMI_MAJOR * (1 - WGS84_FLATTENING);
export const WGS84_ECC_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING);

const GEODETIC_ITERATIONS = 8;

/**
 * Convert geodetic coordinates to ECEF.
 *
 * Usage: place mesh vertices and markers on (or above) the ellipsoid.
 *
 * @param longitudeDeg - Geodetic longitude in degrees.
 * @param latitudeDeg - Geodetic latitude in degrees.
 * @param heightMeters - Height above the ellipsoid in metres (default 0).
 * @returns ECEF position [x, y, z] in metres.
 */
export function lonLatToEcef(longitudeDeg: number, latitudeDeg: number, heightMeters = 0): Vector3d {
  const longitudeRad = (longitudeDeg * Math.PI) / 180;
  const latitudeRad = (latitudeDeg * Math.PI) / 180;
  const sinLatitude = Math.sin(latitudeRad);
  const cosLatitude = Math.cos(latitudeRad);
  const sinLongitude = Math.sin(longitudeRad);
  const cosLongitude = Math.cos(longitudeRad);
  const primeVertical = WGS84_SEMI_MAJOR / Math.sqrt(1 - WGS84_ECC_SQUARED * sinLatitude * sinLatitude);
  const ecefPointX = (primeVertical + heightMeters) * cosLatitude * cosLongitude;
  const ecefPointY = (primeVertical + heightMeters) * cosLatitude * sinLongitude;
  const ecefPointZ = (primeVertical * (1 - WGS84_ECC_SQUARED) + heightMeters) * sinLatitude;
  return [ecefPointX, ecefPointY, ecefPointZ];
}

/**
 * Unit outward ellipsoid normal at a geodetic position.
 *
 * Usage: per-vertex normals of land meshes.
 *
 * @param longitudeDeg - Geodetic longitude in degrees.
 * @param latitudeDeg - Geodetic latitude in degrees.
 * @returns Unit normal [x, y, z].
 */
export function lonLatNormal(longitudeDeg: number, latitudeDeg: number): Vector3d {
  const longitudeRad = (longitudeDeg * Math.PI) / 180;
  const latitudeRad = (latitudeDeg * Math.PI) / 180;
  const sinLatitude = Math.sin(latitudeRad);
  const cosLatitude = Math.cos(latitudeRad);
  const normalVecX = cosLatitude * Math.cos(longitudeRad);
  const normalVecY = cosLatitude * Math.sin(longitudeRad);
  const normalVecZ = sinLatitude;
  const vectorLength = Math.hypot(normalVecX, normalVecY, normalVecZ) || 1;
  return [normalVecX / vectorLength, normalVecY / vectorLength, normalVecZ / vectorLength];
}

/**
 * Scale a vector to unit length.
 *
 * Usage: directions from ECEF positions.
 *
 * @param inputVecX - X component.
 * @param inputVecY - Y component.
 * @param inputVecZ - Z component.
 * @returns The unit vector (the input unchanged when its length is 0).
 */
export function normalizeVector(inputVecX: number, inputVecY: number, inputVecZ: number): Vector3d {
  const vectorLength = Math.hypot(inputVecX, inputVecY, inputVecZ) || 1;
  return [inputVecX / vectorLength, inputVecY / vectorLength, inputVecZ / vectorLength];
}

/**
 * Euclidean distance between two points.
 *
 * Usage: ECEF chord lengths of mesh edges.
 *
 * @param firstPoint - First point.
 * @param secondPoint - Second point.
 * @returns Distance in the points' unit.
 */
export function pointDistance(firstPoint: Vector3d, secondPoint: Vector3d): number {
  return Math.hypot(firstPoint[0] - secondPoint[0], firstPoint[1] - secondPoint[1], firstPoint[2] - secondPoint[2]);
}

/**
 * Geocentric lon/lat of an ECEF position (fast; fine for direction-only uses).
 *
 * Usage: chart centres and normals where geodetic accuracy is not needed.
 *
 * @param ecefPointX - X in metres.
 * @param ecefPointY - Y in metres.
 * @param ecefPointZ - Z in metres.
 * @returns [longitude°, geocentric latitude°].
 */
export function ecefToLonLat(ecefPointX: number, ecefPointY: number, ecefPointZ: number): LonLatPoint {
  const longitudeDeg = (Math.atan2(ecefPointY, ecefPointX) * 180) / Math.PI;
  const planarDist = Math.hypot(ecefPointX, ecefPointY);
  const latitudeDeg = (Math.atan2(ecefPointZ, planarDist) * 180) / Math.PI;
  return [longitudeDeg, latitudeDeg];
}

/**
 * Iterative geodetic lon/lat of an ECEF position (WGS84).
 *
 * Usage: geodesic interpolation of mesh edges (hot path, no height output).
 *
 * @param ecefPointX - X in metres.
 * @param ecefPointY - Y in metres.
 * @param ecefPointZ - Z in metres.
 * @returns [longitude°, geodetic latitude°].
 */
export function ecefToGeodetic(ecefPointX: number, ecefPointY: number, ecefPointZ: number): LonLatPoint {
  const longitudeDeg = (Math.atan2(ecefPointY, ecefPointX) * 180) / Math.PI;
  const planarDist = Math.hypot(ecefPointX, ecefPointY);
  let latitudeRad = Math.atan2(ecefPointZ, planarDist * (1 - WGS84_ECC_SQUARED));
  for (let iteration = 0; iteration < GEODETIC_ITERATIONS; iteration++) {
    const sinLatitude = Math.sin(latitudeRad);
    const primeVertical = WGS84_SEMI_MAJOR / Math.sqrt(1 - WGS84_ECC_SQUARED * sinLatitude * sinLatitude);
    latitudeRad = Math.atan2(ecefPointZ + WGS84_ECC_SQUARED * primeVertical * sinLatitude, planarDist);
  }
  return [longitudeDeg, (latitudeRad * 180) / Math.PI];
}

/** Geodetic position with height. */
export type GeodeticPosition = { latitudeDeg: number; longitudeDeg: number; heightMeters: number };

/**
 * Geodetic latitude, longitude and height of an ECEF position (WGS84).
 *
 * Usage: coordinate read-out and picking.
 *
 * @param ecefPointX - X in metres.
 * @param ecefPointY - Y in metres.
 * @param ecefPointZ - Z in metres.
 * @returns Latitude and longitude in degrees and height above the ellipsoid in metres.
 */
export function ecefToGeodeticHeight(ecefPointX: number, ecefPointY: number, ecefPointZ: number): GeodeticPosition {
  const longitudeRad = Math.atan2(ecefPointY, ecefPointX);
  const planarDist = Math.hypot(ecefPointX, ecefPointY);
  let latitudeRad = Math.atan2(ecefPointZ, planarDist * (1 - WGS84_ECC_SQUARED));
  for (let iteration = 0; iteration < GEODETIC_ITERATIONS; iteration++) {
    const sinLatitude = Math.sin(latitudeRad);
    const primeVertical = WGS84_SEMI_MAJOR / Math.sqrt(1 - WGS84_ECC_SQUARED * sinLatitude * sinLatitude);
    latitudeRad = Math.atan2(ecefPointZ + WGS84_ECC_SQUARED * primeVertical * sinLatitude, planarDist);
  }
  const sinLatitude = Math.sin(latitudeRad);
  const cosLatitude = Math.cos(latitudeRad);
  const primeVertical = WGS84_SEMI_MAJOR / Math.sqrt(1 - WGS84_ECC_SQUARED * sinLatitude * sinLatitude);
  const heightMeters =
    Math.abs(cosLatitude) > 1e-10
      ? planarDist / cosLatitude - primeVertical
      : Math.abs(ecefPointZ) / Math.abs(sinLatitude) - primeVertical * (1 - WGS84_ECC_SQUARED);
  return {
    latitudeDeg: (latitudeRad * 180) / Math.PI,
    longitudeDeg: (longitudeRad * 180) / Math.PI,
    heightMeters,
  };
}

/**
 * Distance from the centre to the ellipsoid surface along a direction.
 *
 * Usage: camera placement above the surface.
 *
 * @param directionX - Direction X (any length).
 * @param directionY - Direction Y.
 * @param directionZ - Direction Z.
 * @returns Radius in metres.
 */
export function ellipsoidRadiusAlong(directionX: number, directionY: number, directionZ: number): number {
  const vectorLength = Math.hypot(directionX, directionY, directionZ) || 1;
  const unitDirX = directionX / vectorLength;
  const unitDirY = directionY / vectorLength;
  const unitDirZ = directionZ / vectorLength;
  return (
    1 /
    Math.sqrt(
      (unitDirX * unitDirX + unitDirY * unitDirY) / (WGS84_SEMI_MAJOR * WGS84_SEMI_MAJOR) +
        (unitDirZ * unitDirZ) / (WGS84_SEMI_MINOR * WGS84_SEMI_MINOR)
    )
  );
}

/**
 * Write the ellipsoid surface point of a GPlates-sphere unit vector into a buffer.
 *
 * Usage: selection track and markers (unit vector = geodetic lon/lat as spherical).
 *
 * @param unitVector - Unit vector [x, y, z].
 * @param targetBuffer - Output buffer.
 * @param bufferOffset - Index of the x component in the buffer.
 * @returns Nothing; writes three floats.
 */
export function writeSurfacePoint(unitVector: ArrayLike<number>, targetBuffer: Float32Array, bufferOffset: number): void {
  const primeVertical = WGS84_SEMI_MAJOR / Math.sqrt(1 - WGS84_ECC_SQUARED * unitVector[2] * unitVector[2]);
  targetBuffer[bufferOffset] = primeVertical * unitVector[0];
  targetBuffer[bufferOffset + 1] = primeVertical * unitVector[1];
  targetBuffer[bufferOffset + 2] = primeVertical * (1 - WGS84_ECC_SQUARED) * unitVector[2];
}
