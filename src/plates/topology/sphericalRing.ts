/** Point-in-ring and orientation tests for rings on the unit sphere (any size, any position). */

import type { UnitVector } from "../sphericalCoords";
import { arcAngle, crossProduct, dotProduct, leftTangent, moveAlong, pointAlongArc, tangentToward } from "../unitVectorMath";

const INSIDE_WINDING = Math.PI;
const MAX_PROBE_OFFSET_RAD = 0.002;
const ORIENTATION_VOTES = 7;

/**
 * Total signed angle the ring's edges sweep around a point.
 *
 * Usage: point-in-ring test. Each edge contributes the angle between its end points
 * as seen from the point in its tangent plane, so the sum is ±2π for points inside
 * and ≈0 outside.
 *
 * @param ringUnits - Ring vertices (implicitly closed).
 * @param probeUnit - Point to test.
 * @returns Winding angle in radians.
 */
export function windingAngle(ringUnits: UnitVector[], probeUnit: UnitVector): number {
  let angleSum = 0;
  for (let pointIdx = 0; pointIdx < ringUnits.length; pointIdx++) {
    const startUnit = ringUnits[pointIdx];
    const arcEndUnit = ringUnits[(pointIdx + 1) % ringUnits.length];
    const sweepSin = dotProduct(probeUnit, crossProduct(startUnit, arcEndUnit));
    const sweepCos = dotProduct(startUnit, arcEndUnit) - dotProduct(probeUnit, startUnit) * dotProduct(probeUnit, arcEndUnit);
    angleSum += Math.atan2(sweepSin, sweepCos);
  }
  return angleSum;
}

/**
 * Whether a point lies inside a ring.
 *
 * Usage: side tests of plate boundaries.
 *
 * @param ringUnits - Ring vertices.
 * @param probeUnit - Point to test.
 * @returns True when the ring winds around the point.
 */
export function ringContains(ringUnits: UnitVector[], probeUnit: UnitVector): boolean {
  return Math.abs(windingAngle(ringUnits, probeUnit)) > INSIDE_WINDING;
}

/**
 * Start indices of the ring's longest edges.
 *
 * Usage: probe edges of the orientation test (long edges give clear side tests).
 *
 * @param ringUnits - Ring vertices.
 * @param edgeCount - How many edges to return.
 * @returns Edge start indices, longest first.
 */
function longestEdges(ringUnits: UnitVector[], edgeCount: number): number[] {
  const edgeLengths = ringUnits.map((startUnit, pointIdx) => arcAngle(startUnit, ringUnits[(pointIdx + 1) % ringUnits.length]));
  return edgeLengths
    .map((edgeLength, pointIdx) => [edgeLength, pointIdx])
    .sort((firstEdge, secondEdge) => secondEdge[0] - firstEdge[0])
    .slice(0, edgeCount)
    .map((edgeEntry) => edgeEntry[1]);
}

/**
 * Side test at one edge: is the point just left of the edge's midpoint inside the ring?
 *
 * Usage: one vote of ringInteriorOnLeft.
 *
 * @param ringUnits - Ring vertices.
 * @param edgeIndex - Start index of the probed edge.
 * @returns True / false, or null for a degenerate edge.
 */
function leftSideInside(ringUnits: UnitVector[], edgeIndex: number): boolean | null {
  const startUnit = ringUnits[edgeIndex];
  const arcEndUnit = ringUnits[(edgeIndex + 1) % ringUnits.length];
  const middleUnit = pointAlongArc(startUnit, arcEndUnit, 0.5);
  const alongUnit = tangentToward(middleUnit, arcEndUnit);
  if (!alongUnit) return null;
  const probeOffset = Math.min(MAX_PROBE_OFFSET_RAD, arcAngle(startUnit, arcEndUnit) * 0.1);
  return ringContains(ringUnits, moveAlong(middleUnit, leftTangent(middleUnit, alongUnit), probeOffset));
}

/**
 * Whether the ring's interior lies to the left of its traversal direction.
 *
 * Usage: once per resolved plate, to tell which side of each boundary the plate is on.
 * Several long edges vote, so a probe that lands in a sliver of an irregular ring
 * does not decide alone.
 *
 * @param ringUnits - Ring vertices (≥ 3).
 * @returns True when the interior is on the left (counter-clockwise seen from outside the sphere).
 */
export function ringInteriorOnLeft(ringUnits: UnitVector[]): boolean {
  let voteBalance = 0;
  for (const edgeIndex of longestEdges(ringUnits, ORIENTATION_VOTES)) {
    const sideVote = leftSideInside(ringUnits, edgeIndex);
    if (sideVote !== null) voteBalance += sideVote ? 1 : -1;
  }
  return voteBalance >= 0;
}
