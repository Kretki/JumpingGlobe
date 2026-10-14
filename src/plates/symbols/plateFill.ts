/**
 * Triangulate a plate polygon on the sphere for a translucent fill.
 *
 * The ring is projected with an azimuthal-equidistant projection centred on the ring,
 * triangulated with earcut, refined until triangle edges are short enough to follow
 * the sphere, and projected back. Works for any ring that stays clear of the
 * antipode of its centre (every plate polygon of the model).
 */

import earcut from "earcut";
import type { UnitVector } from "../sphericalCoords";
import { arcAngle, crossProduct, dotProduct, normalizeOrNull, tangentToward } from "../unitVectorMath";
import type { SymbolGeometry } from "./symbolGeometry";

/** Tangent-plane frame of the projection. */
type ProjectionFrame = { centerUnit: UnitVector; eastUnit: UnitVector; northUnit: UnitVector };
type PlanePoint = [number, number];
type PlaneTriangle = [PlanePoint, PlanePoint, PlanePoint];

const MAX_FILL_EDGE_RAD = (6 * Math.PI) / 180;
const MAX_REFINE_DEPTH = 16;
const MAX_RING_RADIUS_RAD = 2.8;

/**
 * Projection frame centred on a ring.
 *
 * Usage: start of triangulateRing.
 *
 * @param ringUnits - Ring vertices.
 * @returns The frame, or null when the vertices cancel out (ring around a great circle).
 */
function projectionFrame(ringUnits: UnitVector[]): ProjectionFrame | null {
  const vertexSum = ringUnits.reduce((vectorSum, ringUnit) => [vectorSum[0] + ringUnit[0], vectorSum[1] + ringUnit[1], vectorSum[2] + ringUnit[2]], [0, 0, 0]);
  const centerUnit = normalizeOrNull(vertexSum);
  if (!centerUnit) return null;
  const helperAxis: UnitVector = Math.abs(centerUnit[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const eastUnit = normalizeOrNull(crossProduct(helperAxis, centerUnit));
  if (!eastUnit) return null;
  return { centerUnit, eastUnit, northUnit: crossProduct(centerUnit, eastUnit) };
}

/**
 * Azimuthal-equidistant coordinates of a point.
 *
 * Usage: projecting ring vertices.
 *
 * @param projection - Frame.
 * @param pointUnit - Point on the sphere.
 * @returns Plane coordinates (distance in radians along the azimuth).
 */
function projectPoint(projection: ProjectionFrame, pointUnit: UnitVector): PlanePoint {
  const radialDistance = arcAngle(projection.centerUnit, pointUnit);
  const azimuthUnit = tangentToward(projection.centerUnit, pointUnit);
  if (!azimuthUnit) return [0, 0];
  return [radialDistance * dotProduct(azimuthUnit, projection.eastUnit), radialDistance * dotProduct(azimuthUnit, projection.northUnit)];
}

/**
 * Inverse of projectPoint.
 *
 * Usage: refined triangle corners back to the sphere.
 *
 * @param projection - Frame.
 * @param planePoint - Plane coordinates.
 * @returns Point on the sphere.
 */
function unprojectPoint(projection: ProjectionFrame, planePoint: PlanePoint): UnitVector {
  const radialDistance = Math.hypot(planePoint[0], planePoint[1]);
  if (radialDistance < 1e-12) return projection.centerUnit;
  const { centerUnit, eastUnit, northUnit } = projection;
  const eastWeight = planePoint[0] / radialDistance;
  const northWeight = planePoint[1] / radialDistance;
  const cosDistance = Math.cos(radialDistance);
  const sinDistance = Math.sin(radialDistance);
  return [
    centerUnit[0] * cosDistance + (eastUnit[0] * eastWeight + northUnit[0] * northWeight) * sinDistance,
    centerUnit[1] * cosDistance + (eastUnit[1] * eastWeight + northUnit[1] * northWeight) * sinDistance,
    centerUnit[2] * cosDistance + (eastUnit[2] * eastWeight + northUnit[2] * northWeight) * sinDistance,
  ];
}

/**
 * Bisect a plane triangle across its longest edge until all edges are short enough, then emit it.
 *
 * Usage: refinement of every earcut triangle. Longest-edge bisection keeps the
 * triangle count proportional to the area even for the long thin triangles earcut
 * produces.
 *
 * @param trianglePoints - Corners in the plane.
 * @param refineDepth - Remaining bisection levels.
 * @param emitTriangle - Receives final triangles.
 * @returns Nothing.
 */
function refineTriangle(trianglePoints: PlaneTriangle, refineDepth: number, emitTriangle: (trianglePoints: PlaneTriangle) => void): void {
  const [firstPoint, secondPoint, thirdPoint] = trianglePoints;
  const firstEdge = Math.hypot(secondPoint[0] - firstPoint[0], secondPoint[1] - firstPoint[1]);
  const secondEdge = Math.hypot(thirdPoint[0] - secondPoint[0], thirdPoint[1] - secondPoint[1]);
  const thirdEdge = Math.hypot(firstPoint[0] - thirdPoint[0], firstPoint[1] - thirdPoint[1]);
  const longestEdge = Math.max(firstEdge, secondEdge, thirdEdge);
  if (longestEdge <= MAX_FILL_EDGE_RAD || refineDepth <= 0) {
    emitTriangle(trianglePoints);
    return;
  }
  // Rotate the corners so the longest edge runs from edgeStart to edgeFinish.
  const [edgeStart, edgeFinish, oppositeCorner] =
    longestEdge === firstEdge ? trianglePoints : longestEdge === secondEdge ? [secondPoint, thirdPoint, firstPoint] : [thirdPoint, firstPoint, secondPoint];
  const splitPoint: PlanePoint = [(edgeStart[0] + edgeFinish[0]) / 2, (edgeStart[1] + edgeFinish[1]) / 2];
  refineTriangle([edgeStart, splitPoint, oppositeCorner], refineDepth - 1, emitTriangle);
  refineTriangle([splitPoint, edgeFinish, oppositeCorner], refineDepth - 1, emitTriangle);
}

/**
 * Add the fill triangles of a plate ring.
 *
 * Usage: subducting-plate shading.
 *
 * @param ringUnits - Ring vertices (≥ 3).
 * @param symbolGeometry - Target geometry.
 * @returns Nothing; rings that cannot be projected are skipped.
 */
export function addRingFill(ringUnits: UnitVector[], symbolGeometry: SymbolGeometry): void {
  const projection = projectionFrame(ringUnits);
  if (!projection) return;
  if (ringUnits.some((ringUnit) => arcAngle(projection.centerUnit, ringUnit) > MAX_RING_RADIUS_RAD)) return;
  const planePoints = ringUnits.map((ringUnit) => projectPoint(projection, ringUnit));
  const triangleIndices = earcut(planePoints.flat());
  // Neighbouring refined triangles share corners (the same array objects), so cache by identity.
  const sphereByPoint = new Map<PlanePoint, UnitVector>();
  const unprojectCached = (planePoint: PlanePoint): UnitVector => {
    let sphereUnit = sphereByPoint.get(planePoint);
    if (!sphereUnit) {
      sphereUnit = unprojectPoint(projection, planePoint);
      sphereByPoint.set(planePoint, sphereUnit);
    }
    return sphereUnit;
  };
  for (let cornerIdx = 0; cornerIdx + 2 < triangleIndices.length; cornerIdx += 3) {
    const trianglePoints: PlaneTriangle = [
      planePoints[triangleIndices[cornerIdx]],
      planePoints[triangleIndices[cornerIdx + 1]],
      planePoints[triangleIndices[cornerIdx + 2]],
    ];
    refineTriangle(trianglePoints, MAX_REFINE_DEPTH, ([firstPoint, secondPoint, thirdPoint]) =>
      symbolGeometry.addTriangle(unprojectCached(firstPoint), unprojectCached(secondPoint), unprojectCached(thirdPoint))
    );
  }
}
