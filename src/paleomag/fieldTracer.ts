/** Trace magnetic field lines through the charge model (fieldSources.ts) with fixed-length Runge–Kutta steps. */

import type { UnitVector } from "../plates/sphericalCoords";
import { fieldAtPoint, type MagneticCharge } from "./fieldSources";

/** Step length near the ground (Earth radii); steps grow with the distance from the centre. */
const BASE_STEP = 0.008;
const MAX_TRACE_STEPS = 4000;
/** Lines that get this far (Earth radii) are cut off. */
export const MAX_TRACE_RADIUS = 5;

/** A traced line in Earth radii, from its start on the ground. */
export type TracedLine = { linePoints: UnitVector[]; returnsToGround: boolean };

/**
 * Unit field direction at a point (zero vector where the field vanishes).
 *
 * Usage: tracing steps.
 *
 * @param fieldCharges - Charges.
 * @param tracePoint - Point (Earth radii).
 * @returns Unit direction.
 */
function fieldDirection(fieldCharges: MagneticCharge[], tracePoint: UnitVector): UnitVector {
  const fieldVector: UnitVector = [0, 0, 0];
  fieldAtPoint(fieldCharges, tracePoint[0], tracePoint[1], tracePoint[2], fieldVector);
  const fieldLength = Math.hypot(fieldVector[0], fieldVector[1], fieldVector[2]);
  return fieldLength > 1e-12 ? [fieldVector[0] / fieldLength, fieldVector[1] / fieldLength, fieldVector[2] / fieldLength] : [0, 0, 0];
}

/**
 * Point offset along a direction.
 *
 * Usage: Runge–Kutta stages.
 *
 * @param basePoint - Start.
 * @param stepDirection - Direction.
 * @param stepLength - Distance.
 * @returns basePoint + stepLength · stepDirection.
 */
function offsetPoint(basePoint: UnitVector, stepDirection: UnitVector, stepLength: number): UnitVector {
  return [basePoint[0] + stepLength * stepDirection[0], basePoint[1] + stepLength * stepDirection[1], basePoint[2] + stepLength * stepDirection[2]];
}

/**
 * One 4th-order Runge–Kutta step along the unit field direction.
 *
 * Usage: traceFieldLine.
 *
 * @param fieldCharges - Charges.
 * @param startPoint - Current point.
 * @param stepLength - Step length (Earth radii).
 * @returns The next point.
 */
function rungeKuttaStep(fieldCharges: MagneticCharge[], startPoint: UnitVector, stepLength: number): UnitVector {
  const firstSlope = fieldDirection(fieldCharges, startPoint);
  const secondSlope = fieldDirection(fieldCharges, offsetPoint(startPoint, firstSlope, stepLength / 2));
  const thirdSlope = fieldDirection(fieldCharges, offsetPoint(startPoint, secondSlope, stepLength / 2));
  const fourthSlope = fieldDirection(fieldCharges, offsetPoint(startPoint, thirdSlope, stepLength));
  return [0, 1, 2].map(
    (axisIndex) =>
      startPoint[axisIndex] + (stepLength / 6) * (firstSlope[axisIndex] + 2 * secondSlope[axisIndex] + 2 * thirdSlope[axisIndex] + fourthSlope[axisIndex])
  ) as UnitVector;
}

/**
 * Trace a line from a ground point along the field until it returns to the ground.
 *
 * Usage: one per seed. The seed must be where the field leaves the ground.
 *
 * @param fieldCharges - Charges.
 * @param startUnit - Seed on the unit sphere.
 * @returns The line (the last point moved onto the ground when it returns), or null when the
 *   field at the seed points into the ground or vanishes.
 */
export function traceFieldLine(fieldCharges: MagneticCharge[], startUnit: UnitVector): TracedLine | null {
  const startDirection = fieldDirection(fieldCharges, startUnit);
  if (startDirection[0] * startUnit[0] + startDirection[1] * startUnit[1] + startDirection[2] * startUnit[2] <= 0) return null;
  const linePoints: UnitVector[] = [startUnit];
  let currentPoint = startUnit;
  for (let stepIndex = 0; stepIndex < MAX_TRACE_STEPS; stepIndex++) {
    const pointRadius = Math.hypot(currentPoint[0], currentPoint[1], currentPoint[2]);
    const nextPoint = rungeKuttaStep(fieldCharges, currentPoint, BASE_STEP * Math.max(1, pointRadius));
    const nextRadius = Math.hypot(nextPoint[0], nextPoint[1], nextPoint[2]);
    if (nextRadius <= 1) {
      linePoints.push([nextPoint[0] / nextRadius, nextPoint[1] / nextRadius, nextPoint[2] / nextRadius]);
      return { linePoints, returnsToGround: true };
    }
    linePoints.push(nextPoint);
    if (nextRadius > MAX_TRACE_RADIUS || (nextPoint[0] === currentPoint[0] && nextPoint[1] === currentPoint[1] && nextPoint[2] === currentPoint[2])) break;
    currentPoint = nextPoint;
  }
  return { linePoints, returnsToGround: false };
}

/**
 * Resample a polyline to evenly spaced points.
 *
 * Usage: give every drawn line the same vertex count.
 *
 * @param linePoints - Dense points (≥ 2).
 * @param segmentCount - Output segments (≥ 1).
 * @returns segmentCount + 1 points from the first to the last input point.
 */
export function resampleLine(linePoints: UnitVector[], segmentCount: number): UnitVector[] {
  const cumulativeLengths = [0];
  for (let pointIdx = 1; pointIdx < linePoints.length; pointIdx++) {
    const [previousX, previousY, previousZ] = linePoints[pointIdx - 1];
    const [currentX, currentY, currentZ] = linePoints[pointIdx];
    cumulativeLengths.push(cumulativeLengths[pointIdx - 1] + Math.hypot(currentX - previousX, currentY - previousY, currentZ - previousZ));
  }
  const totalLength = cumulativeLengths[cumulativeLengths.length - 1];
  const sampledPoints: UnitVector[] = [];
  let segmentIdx = 1;
  for (let sampleIdx = 0; sampleIdx <= segmentCount; sampleIdx++) {
    const targetLength = (totalLength * sampleIdx) / segmentCount;
    while (segmentIdx < linePoints.length - 1 && cumulativeLengths[segmentIdx] < targetLength) segmentIdx++;
    const segmentLength = cumulativeLengths[segmentIdx] - cumulativeLengths[segmentIdx - 1] || 1;
    const segmentFraction = Math.min(1, Math.max(0, (targetLength - cumulativeLengths[segmentIdx - 1]) / segmentLength));
    const startPoint = linePoints[segmentIdx - 1];
    const endPoint = linePoints[segmentIdx];
    sampledPoints.push([0, 1, 2].map((axisIndex) => startPoint[axisIndex] + (endPoint[axisIndex] - startPoint[axisIndex]) * segmentFraction) as UnitVector);
  }
  return sampledPoints;
}
