/** Vector helpers on the unit sphere (GPlates sphere): products, arcs and tangent-plane moves. */

import type { UnitVector } from "./sphericalCoords";

/**
 * Dot product.
 *
 * Usage: angles and side tests.
 *
 * @param firstVec - First vector.
 * @param secondVec - Second vector.
 * @returns firstVec · secondVec.
 */
export function dotProduct(firstVec: ArrayLike<number>, secondVec: ArrayLike<number>): number {
  return firstVec[0] * secondVec[0] + firstVec[1] * secondVec[1] + firstVec[2] * secondVec[2];
}

/**
 * Cross product.
 *
 * Usage: great-circle normals and tangent directions.
 *
 * @param firstVec - First vector.
 * @param secondVec - Second vector.
 * @returns firstVec × secondVec (not normalised).
 */
export function crossProduct(firstVec: ArrayLike<number>, secondVec: ArrayLike<number>): UnitVector {
  return [
    firstVec[1] * secondVec[2] - firstVec[2] * secondVec[1],
    firstVec[2] * secondVec[0] - firstVec[0] * secondVec[2],
    firstVec[0] * secondVec[1] - firstVec[1] * secondVec[0],
  ];
}

/**
 * Scale a vector to unit length.
 *
 * Usage: after blending or offsetting.
 *
 * @param inputVec - Vector.
 * @returns The unit vector, or null for a (near) zero vector.
 */
export function normalizeOrNull(inputVec: ArrayLike<number>): UnitVector | null {
  const vectorLength = Math.hypot(inputVec[0], inputVec[1], inputVec[2]);
  if (vectorLength < 1e-15) return null;
  return [inputVec[0] / vectorLength, inputVec[1] / vectorLength, inputVec[2] / vectorLength];
}

/**
 * Great-circle angle between two unit vectors.
 *
 * Usage: edge lengths, densification, sampling.
 *
 * @param firstUnit - First unit vector.
 * @param secondUnit - Second unit vector.
 * @returns Angle in radians, 0..π.
 */
export function arcAngle(firstUnit: UnitVector, secondUnit: UnitVector): number {
  const crossVec = crossProduct(firstUnit, secondUnit);
  return Math.atan2(Math.hypot(crossVec[0], crossVec[1], crossVec[2]), dotProduct(firstUnit, secondUnit));
}

/**
 * Point at a fraction of the great-circle arc between two unit vectors (spherical interpolation).
 *
 * Usage: densify edges and cut polylines; the fraction is proportional to the angle,
 * so it matches the params computed by the arc-intersection code.
 *
 * @param startUnit - Arc start.
 * @param arcEndUnit - Arc end (not antipodal to the start).
 * @param fraction - Position along the arc, 0..1.
 * @returns Unit vector on the arc.
 */
export function pointAlongArc(startUnit: UnitVector, arcEndUnit: UnitVector, fraction: number): UnitVector {
  const totalAngle = arcAngle(startUnit, arcEndUnit);
  const sinTotal = Math.sin(totalAngle);
  if (sinTotal < 1e-12) return startUnit;
  const startWeight = Math.sin((1 - fraction) * totalAngle) / sinTotal;
  const endWeight = Math.sin(fraction * totalAngle) / sinTotal;
  return [
    startUnit[0] * startWeight + arcEndUnit[0] * endWeight,
    startUnit[1] * startWeight + arcEndUnit[1] * endWeight,
    startUnit[2] * startWeight + arcEndUnit[2] * endWeight,
  ];
}

/**
 * Unit tangent at a point pointing along the great circle towards another point.
 *
 * Usage: line directions for symbols.
 *
 * @param baseUnit - Point on the sphere.
 * @param targetUnit - Point to head towards.
 * @returns Tangent unit vector at baseUnit, or null when the points coincide or are antipodal.
 */
export function tangentToward(baseUnit: UnitVector, targetUnit: UnitVector): UnitVector | null {
  const alongDot = dotProduct(baseUnit, targetUnit);
  return normalizeOrNull([
    targetUnit[0] - baseUnit[0] * alongDot,
    targetUnit[1] - baseUnit[1] * alongDot,
    targetUnit[2] - baseUnit[2] * alongDot,
  ]);
}

/**
 * Move along a great circle from a point in a tangent direction.
 *
 * Usage: place symbol vertices (teeth, arrows, ticks) next to a line.
 *
 * @param baseUnit - Start point.
 * @param tangentUnit - Unit tangent at baseUnit.
 * @param angleRad - Distance in radians (negative moves backwards).
 * @returns The destination unit vector.
 */
export function moveAlong(baseUnit: UnitVector, tangentUnit: UnitVector, angleRad: number): UnitVector {
  const cosAngle = Math.cos(angleRad);
  const sinAngle = Math.sin(angleRad);
  return [
    baseUnit[0] * cosAngle + tangentUnit[0] * sinAngle,
    baseUnit[1] * cosAngle + tangentUnit[1] * sinAngle,
    baseUnit[2] * cosAngle + tangentUnit[2] * sinAngle,
  ];
}

/**
 * Unit tangent pointing to the left of a direction of travel.
 *
 * Usage: sides of boundaries (subduction polarity, spreading arrows).
 *
 * @param baseUnit - Point on the sphere (outward normal).
 * @param tangentUnit - Direction of travel at that point.
 * @returns baseUnit × tangentUnit (left-hand side when looking down on the sphere).
 */
export function leftTangent(baseUnit: UnitVector, tangentUnit: UnitVector): UnitVector {
  return crossProduct(baseUnit, tangentUnit);
}
