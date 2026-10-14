/** Coordinates around an arbitrary axis on the sphere: orthonormal basis and small circles. */

import type { UnitVector } from "../plates/sphericalCoords";
import { crossProduct, normalizeOrNull } from "../plates/unitVectorMath";

const DEG_TO_RAD = Math.PI / 180;

/** Axis plus two unit vectors spanning the plane perpendicular to it. */
export type AxisBasis = { axisUnit: UnitVector; firstUnit: UnitVector; secondUnit: UnitVector };

/**
 * Right-handed orthonormal basis whose third vector is the axis.
 *
 * Usage: field lines and circles around a pole; the azimuth origin is arbitrary but stable.
 *
 * @param axisUnit - Unit axis.
 * @returns The basis (firstUnit × secondUnit = axisUnit).
 */
export function basisAround(axisUnit: UnitVector): AxisBasis {
  const helperUnit: UnitVector = Math.abs(axisUnit[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const firstUnit = normalizeOrNull(crossProduct(helperUnit, axisUnit)) ?? [1, 0, 0];
  return { axisUnit, firstUnit, secondUnit: crossProduct(axisUnit, firstUnit) };
}

/**
 * Direction at a colatitude and azimuth around the basis axis.
 *
 * Usage: sample circles and field lines.
 *
 * @param axisBasis - Basis.
 * @param colatitudeRad - Angle from the axis, radians.
 * @param azimuthRad - Angle around the axis from firstUnit, radians.
 * @returns Unit direction.
 */
export function directionAround(axisBasis: AxisBasis, colatitudeRad: number, azimuthRad: number): UnitVector {
  const sinColatitude = Math.sin(colatitudeRad);
  const cosColatitude = Math.cos(colatitudeRad);
  const firstWeight = sinColatitude * Math.cos(azimuthRad);
  const secondWeight = sinColatitude * Math.sin(azimuthRad);
  return [0, 1, 2].map(
    (axisIndex) =>
      cosColatitude * axisBasis.axisUnit[axisIndex] + firstWeight * axisBasis.firstUnit[axisIndex] + secondWeight * axisBasis.secondUnit[axisIndex]
  ) as UnitVector;
}

/**
 * Closed small circle around a centre.
 *
 * Usage: pole markers and 95 % confidence circles.
 *
 * @param centerUnit - Circle centre.
 * @param radiusDeg - Angular radius in degrees (0..180).
 * @param sampleCount - Number of vertices (≥ 3).
 * @returns Vertices; the first one is repeated at the end.
 */
export function smallCircle(centerUnit: UnitVector, radiusDeg: number, sampleCount: number): UnitVector[] {
  const axisBasis = basisAround(centerUnit);
  const circleUnits: UnitVector[] = [];
  for (let sampleIdx = 0; sampleIdx <= sampleCount; sampleIdx++) {
    circleUnits.push(directionAround(axisBasis, radiusDeg * DEG_TO_RAD, (2 * Math.PI * sampleIdx) / sampleCount));
  }
  return circleUnits;
}
