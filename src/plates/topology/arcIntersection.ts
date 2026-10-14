/**
 * Intersections of polylines made of great-circle arcs, and cutting polylines at them.
 *
 * Positions along a polyline are "params": segment index + fraction along that segment
 * (0 = first vertex, n-1 = last vertex).
 */

import type { UnitVector } from "../sphericalCoords";
import { arcAngle, crossProduct, dotProduct, normalizeOrNull, pointAlongArc } from "../unitVectorMath";

/** One crossing of two polylines. */
export type PolylineHit = { firstParam: number; secondParam: number };

/** Axis-aligned box in 3D: [minX, minY, minZ, maxX, maxY, maxZ]. */
type BoxBounds = [number, number, number, number, number, number];

const SIDE_TOLERANCE = -1e-12;

/**
 * Box around an arc (its chord box, padded for the arc's bulge).
 *
 * Usage: cheap rejection before the exact arc test.
 *
 * @param startUnit - Arc start.
 * @param arcEndUnit - Arc end.
 * @returns Padded bounds.
 */
function arcBounds(startUnit: UnitVector, arcEndUnit: UnitVector): BoxBounds {
  // The arc leaves its chord by at most 1 - cos(θ/2) ≤ (1 - cos θ) / 2.
  const bulgePad = (1 - dotProduct(startUnit, arcEndUnit)) * 0.5 + 1e-9;
  return [
    Math.min(startUnit[0], arcEndUnit[0]) - bulgePad,
    Math.min(startUnit[1], arcEndUnit[1]) - bulgePad,
    Math.min(startUnit[2], arcEndUnit[2]) - bulgePad,
    Math.max(startUnit[0], arcEndUnit[0]) + bulgePad,
    Math.max(startUnit[1], arcEndUnit[1]) + bulgePad,
    Math.max(startUnit[2], arcEndUnit[2]) + bulgePad,
  ];
}

/**
 * Union of two boxes.
 *
 * Usage: polyline bounds.
 *
 * @param firstBox - First box.
 * @param secondBox - Second box.
 * @returns The enclosing box.
 */
function mergeBounds(firstBox: BoxBounds, secondBox: BoxBounds): BoxBounds {
  return [
    Math.min(firstBox[0], secondBox[0]),
    Math.min(firstBox[1], secondBox[1]),
    Math.min(firstBox[2], secondBox[2]),
    Math.max(firstBox[3], secondBox[3]),
    Math.max(firstBox[4], secondBox[4]),
    Math.max(firstBox[5], secondBox[5]),
  ];
}

/**
 * Whether two boxes overlap.
 *
 * Usage: rejection tests.
 *
 * @param firstBox - First box.
 * @param secondBox - Second box.
 * @returns True when they intersect.
 */
function boundsOverlap(firstBox: BoxBounds, secondBox: BoxBounds): boolean {
  return (
    firstBox[0] <= secondBox[3] && secondBox[0] <= firstBox[3] &&
    firstBox[1] <= secondBox[4] && secondBox[1] <= firstBox[4] &&
    firstBox[2] <= secondBox[5] && secondBox[2] <= firstBox[5]
  );
}

/**
 * Whether a point on an arc's great circle lies within the arc.
 *
 * Usage: exact arc-intersection test.
 *
 * @param startUnit - Arc start.
 * @param arcEndUnit - Arc end.
 * @param arcNormal - startUnit × arcEndUnit.
 * @param candidateUnit - Point on the great circle.
 * @returns True when the point is between the ends (inclusive).
 */
function withinArc(startUnit: UnitVector, arcEndUnit: UnitVector, arcNormal: UnitVector, candidateUnit: UnitVector): boolean {
  return (
    dotProduct(crossProduct(startUnit, candidateUnit), arcNormal) >= SIDE_TOLERANCE &&
    dotProduct(crossProduct(candidateUnit, arcEndUnit), arcNormal) >= SIDE_TOLERANCE
  );
}

/**
 * Crossing point of two great-circle arcs.
 *
 * Usage: per candidate segment pair.
 *
 * @param firstStart - First arc start.
 * @param firstEnd - First arc end.
 * @param secondStart - Second arc start.
 * @param secondEnd - Second arc end.
 * @returns Fractions along each arc, or null when they do not cross (or are parallel/degenerate).
 */
function arcCrossing(firstStart: UnitVector, firstEnd: UnitVector, secondStart: UnitVector, secondEnd: UnitVector): [number, number] | null {
  const firstNormal = crossProduct(firstStart, firstEnd);
  const secondNormal = crossProduct(secondStart, secondEnd);
  const crossingAxis = normalizeOrNull(crossProduct(firstNormal, secondNormal));
  if (!crossingAxis) return null;
  for (const candidateUnit of [crossingAxis, [-crossingAxis[0], -crossingAxis[1], -crossingAxis[2]] as UnitVector]) {
    if (!withinArc(firstStart, firstEnd, firstNormal, candidateUnit)) continue;
    if (!withinArc(secondStart, secondEnd, secondNormal, candidateUnit)) continue;
    const firstLength = arcAngle(firstStart, firstEnd);
    const secondLength = arcAngle(secondStart, secondEnd);
    if (firstLength <= 0 || secondLength <= 0) return null;
    return [Math.min(1, arcAngle(firstStart, candidateUnit) / firstLength), Math.min(1, arcAngle(secondStart, candidateUnit) / secondLength)];
  }
  return null;
}

/**
 * Per-segment boxes and the overall box of a polyline.
 *
 * Usage: computed once per polyline per intersection query.
 *
 * @param polylinePoints - Polyline vertices.
 * @returns Segment boxes and their union.
 */
function polylineBounds(polylinePoints: UnitVector[]): { segmentBoxes: BoxBounds[]; wholeBox: BoxBounds } {
  const segmentBoxes: BoxBounds[] = [];
  for (let pointIdx = 1; pointIdx < polylinePoints.length; pointIdx++) {
    segmentBoxes.push(arcBounds(polylinePoints[pointIdx - 1], polylinePoints[pointIdx]));
  }
  const wholeBox = segmentBoxes.reduce(mergeBounds, segmentBoxes[0] ?? [0, 0, 0, 0, 0, 0]);
  return { segmentBoxes, wholeBox };
}

/**
 * All crossings of two polylines.
 *
 * Usage: clipping adjacent topology sections.
 *
 * @param firstLine - First polyline (≥ 2 points).
 * @param secondLine - Second polyline (≥ 2 points).
 * @returns Crossings with params on both polylines, ordered along the first.
 */
export function intersectPolylines(firstLine: UnitVector[], secondLine: UnitVector[]): PolylineHit[] {
  if (firstLine.length < 2 || secondLine.length < 2) return [];
  const firstBounds = polylineBounds(firstLine);
  const secondBounds = polylineBounds(secondLine);
  if (!boundsOverlap(firstBounds.wholeBox, secondBounds.wholeBox)) return [];
  const crossingList: PolylineHit[] = [];
  for (let firstIdx = 0; firstIdx < firstBounds.segmentBoxes.length; firstIdx++) {
    const firstBox = firstBounds.segmentBoxes[firstIdx];
    if (!boundsOverlap(firstBox, secondBounds.wholeBox)) continue;
    for (let secondIdx = 0; secondIdx < secondBounds.segmentBoxes.length; secondIdx++) {
      if (!boundsOverlap(firstBox, secondBounds.segmentBoxes[secondIdx])) continue;
      const crossing = arcCrossing(firstLine[firstIdx], firstLine[firstIdx + 1], secondLine[secondIdx], secondLine[secondIdx + 1]);
      if (crossing) crossingList.push({ firstParam: firstIdx + crossing[0], secondParam: secondIdx + crossing[1] });
    }
  }
  return crossingList.sort((firstHit, secondHit) => firstHit.firstParam - secondHit.firstParam);
}

/**
 * Point at a param of a polyline.
 *
 * Usage: cut points.
 *
 * @param polylinePoints - Polyline (≥ 2 points).
 * @param pointParam - Param in [0, n-1].
 * @returns The point on the polyline.
 */
export function pointAtParam(polylinePoints: UnitVector[], pointParam: number): UnitVector {
  const segmentIdx = Math.min(Math.max(Math.floor(pointParam), 0), polylinePoints.length - 2);
  return pointAlongArc(polylinePoints[segmentIdx], polylinePoints[segmentIdx + 1], pointParam - segmentIdx);
}

/**
 * Part of a polyline between two params.
 *
 * Usage: keep the clipped piece of a topology section.
 *
 * @param polylinePoints - Polyline (≥ 2 points).
 * @param startParam - Start param.
 * @param endParam - End param (> startParam).
 * @returns The cut points plus the original vertices strictly between them.
 */
export function slicePolyline(polylinePoints: UnitVector[], startParam: number, endParam: number): UnitVector[] {
  const slicedPoints: UnitVector[] = [pointAtParam(polylinePoints, startParam)];
  for (let pointIdx = Math.floor(startParam) + 1; pointIdx < endParam && pointIdx < polylinePoints.length; pointIdx++) {
    slicedPoints.push(polylinePoints[pointIdx]);
  }
  slicedPoints.push(pointAtParam(polylinePoints, endParam));
  return slicedPoints;
}
