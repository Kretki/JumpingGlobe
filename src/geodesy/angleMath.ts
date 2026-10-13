/** Scalar and longitude helpers shared by the land and plate code. */

/**
 * Clamp a value into a closed range.
 *
 * Usage: bound latitudes, percentages and angles.
 *
 * @param inputValue - Value to clamp.
 * @param lowerBound - Minimum.
 * @param upperBound - Maximum.
 * @returns The clamped value.
 */
export function clampValue(inputValue: number, lowerBound: number, upperBound: number): number {
  return Math.max(lowerBound, Math.min(upperBound, inputValue));
}

/**
 * Normalise a longitude into (-180, 180] (−180 maps to +180).
 *
 * Usage: mesh vertices and polar charts.
 *
 * @param longitudeDeg - Longitude in degrees, any value.
 * @returns Equivalent longitude in (-180, 180].
 */
export function normalizeLongitude(longitudeDeg: number): number {
  let wrappedDeg = ((((longitudeDeg + 180) % 360) + 360) % 360) - 180;
  if (wrappedDeg === -180) wrappedDeg = 180;
  return wrappedDeg;
}

/**
 * Wrap a longitude into [-180, 180).
 *
 * Usage: view-box edges computed from a centre ± half width.
 *
 * @param longitudeDeg - Longitude in degrees, any value.
 * @returns Equivalent longitude in [-180, 180).
 */
export function wrapLongitude(longitudeDeg: number): number {
  return ((((longitudeDeg + 180) % 360) + 360) % 360) - 180;
}

/**
 * Shift a longitude by whole turns so it lies within 180° of a reference.
 *
 * Usage: keep consecutive ring vertices in one continuous longitude frame.
 *
 * @param longitudeDeg - Longitude to shift.
 * @param referenceDeg - Reference longitude.
 * @returns longitudeDeg + k·360 with |result − referenceDeg| ≤ 180.
 */
export function unwrapLongitudeNear(longitudeDeg: number, referenceDeg: number): number {
  let shiftedDeg = longitudeDeg;
  while (shiftedDeg - referenceDeg > 180) shiftedDeg -= 360;
  while (shiftedDeg - referenceDeg < -180) shiftedDeg += 360;
  return shiftedDeg;
}

/**
 * Normalise a lon/lat pair: longitude into (-180, 180], latitude clamped to [-90, 90].
 *
 * Usage: mesh vertices built from unwrapped rings.
 *
 * @param lonLatPair - [longitude°, latitude°].
 * @returns New normalised pair.
 */
export function normalizeLonLat(lonLatPair: [number, number]): [number, number] {
  return [normalizeLongitude(lonLatPair[0]), clampValue(lonLatPair[1], -90, 90)];
}
