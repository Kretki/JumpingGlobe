/** Refine triangle meshes on the ellipsoid until every edge fits the LOD's length budget. */

import type { Vector3d } from "../geodesy/wgs84Ellipsoid";
import { geodesicPoint, LAND_HEIGHT_M } from "./geodesicDensify";

/** Edge keys pack two vertex indices; indices stay far below 2^26 per piece. */
const EDGE_KEY_STRIDE = 67108864;
const BUDGET_SLACK = 1.02;
const DEFAULT_MAX_PASSES = 24;

/**
 * Order a triangle so its normal points away from the globe centre.
 *
 * Usage: every emitted triangle (back-face culling relies on it).
 *
 * @param positionData - Flat ECEF positions.
 * @param firstVertex - Vertex index A.
 * @param secondVertex - Vertex index B.
 * @param thirdVertex - Vertex index C.
 * @returns The three indices, swapped to (A, C, B) when the input faced inward.
 */
export function ensureOutward(
  positionData: number[],
  firstVertex: number,
  secondVertex: number,
  thirdVertex: number
): [number, number, number] {
  const originVecX = positionData[firstVertex * 3];
  const originVecY = positionData[firstVertex * 3 + 1];
  const originVecZ = positionData[firstVertex * 3 + 2];
  const edgeOneX = positionData[secondVertex * 3] - originVecX;
  const edgeOneY = positionData[secondVertex * 3 + 1] - originVecY;
  const edgeOneZ = positionData[secondVertex * 3 + 2] - originVecZ;
  const edgeTwoX = positionData[thirdVertex * 3] - originVecX;
  const edgeTwoY = positionData[thirdVertex * 3 + 1] - originVecY;
  const edgeTwoZ = positionData[thirdVertex * 3 + 2] - originVecZ;
  const normalVecX = edgeOneY * edgeTwoZ - edgeOneZ * edgeTwoY;
  const normalVecY = edgeOneZ * edgeTwoX - edgeOneX * edgeTwoZ;
  const normalVecZ = edgeOneX * edgeTwoY - edgeOneY * edgeTwoX;
  // Outward when normal · A > 0 (the origin is inside the Earth).
  const outwardDot = normalVecX * originVecX + normalVecY * originVecY + normalVecZ * originVecZ;
  if (outwardDot < 0) return [firstVertex, thirdVertex, secondVertex];
  return [firstVertex, secondVertex, thirdVertex];
}

/**
 * Chord length between two vertices.
 *
 * Usage: edge budget checks.
 *
 * @param positionData - Flat ECEF positions.
 * @param firstVertex - Vertex index.
 * @param secondVertex - Vertex index.
 * @returns Distance in metres.
 */
export function edgeLength(positionData: number[], firstVertex: number, secondVertex: number): number {
  return Math.hypot(
    positionData[firstVertex * 3] - positionData[secondVertex * 3],
    positionData[firstVertex * 3 + 1] - positionData[secondVertex * 3 + 1],
    positionData[firstVertex * 3 + 2] - positionData[secondVertex * 3 + 2]
  );
}

/**
 * Append a triangle in outward order.
 *
 * Usage: refinement output.
 *
 * @param targetIndices - Index list to append to.
 * @param positionData - Flat ECEF positions.
 * @param firstVertex - Vertex index A.
 * @param secondVertex - Vertex index B.
 * @param thirdVertex - Vertex index C.
 * @returns Nothing.
 */
function pushOutward(
  targetIndices: number[],
  positionData: number[],
  firstVertex: number,
  secondVertex: number,
  thirdVertex: number
): void {
  const [orderedA, orderedB, orderedC] = ensureOutward(positionData, firstVertex, secondVertex, thirdVertex);
  targetIndices.push(orderedA, orderedB, orderedC);
}

/**
 * Longest edge over all triangles.
 *
 * Usage: report the achieved edge length after refinement.
 *
 * @param positionData - Flat ECEF positions.
 * @param indexList - Flat triangle indices.
 * @returns Maximum edge length in metres.
 */
function longestEdge(positionData: number[], indexList: number[]): number {
  let maxEdgeLength = 0;
  for (let triangleStart = 0; triangleStart < indexList.length; triangleStart += 3) {
    maxEdgeLength = Math.max(
      maxEdgeLength,
      edgeLength(positionData, indexList[triangleStart], indexList[triangleStart + 1]),
      edgeLength(positionData, indexList[triangleStart + 1], indexList[triangleStart + 2]),
      edgeLength(positionData, indexList[triangleStart + 2], indexList[triangleStart])
    );
  }
  return maxEdgeLength;
}

/**
 * Rivara longest-edge bisection on the ellipsoid.
 *
 * Usage: after triangulation. Each pass splits only the longest edge of each
 * triangle (shared midpoints), which avoids multi-edge patterns that re-introduce
 * longer diagonals on spherical caps. Triangles under budget never change again,
 * so they are moved out once instead of being re-measured on every pass.
 *
 * @param positionData - Flat ECEF positions; midpoints are appended in place.
 * @param indexList - Flat triangle indices; replaced in place by the refined mesh.
 * @param maxEdgeMeters - Edge budget.
 * @param heightMeters - Height of inserted midpoints above the ellipsoid.
 * @param maxPasses - Iteration cap (leftovers keep their over-budget edges).
 * @returns The longest edge of the refined mesh, in metres.
 */
export function splitLongEdges(
  positionData: number[],
  indexList: number[],
  maxEdgeMeters: number,
  heightMeters = LAND_HEIGHT_M,
  maxPasses = DEFAULT_MAX_PASSES
): { maxEdgeLength: number } {
  const edgeBudget = maxEdgeMeters * BUDGET_SLACK;
  const edgeCacheKey = (vertexIdxA: number, vertexIdxB: number) =>
    vertexIdxA < vertexIdxB ? vertexIdxA * EDGE_KEY_STRIDE + vertexIdxB : vertexIdxB * EDGE_KEY_STRIDE + vertexIdxA;

  const finishedIndices: number[] = [];
  let activeIndices = indexList.slice();

  for (let passIndex = 0; passIndex < maxPasses; passIndex++) {
    const midpointCache = new Map<number, number>();
    const midpointOf = (vertexIdxA: number, vertexIdxB: number): number => {
      const cacheKey = edgeCacheKey(vertexIdxA, vertexIdxB);
      const cachedIndex = midpointCache.get(cacheKey);
      if (cachedIndex !== undefined) return cachedIndex;
      const startPoint: Vector3d = [positionData[vertexIdxA * 3], positionData[vertexIdxA * 3 + 1], positionData[vertexIdxA * 3 + 2]];
      const endPoint: Vector3d = [positionData[vertexIdxB * 3], positionData[vertexIdxB * 3 + 1], positionData[vertexIdxB * 3 + 2]];
      const midPoint = geodesicPoint(startPoint, endPoint, 0.5, heightMeters);
      const newIndex = positionData.length / 3;
      positionData.push(midPoint[0], midPoint[1], midPoint[2]);
      midpointCache.set(cacheKey, newIndex);
      return newIndex;
    };

    const nextActive: number[] = [];
    for (let triangleStart = 0; triangleStart < activeIndices.length; triangleStart += 3) {
      const vertexIdxA = activeIndices[triangleStart];
      const vertexIdxB = activeIndices[triangleStart + 1];
      const vertexIdxC = activeIndices[triangleStart + 2];
      const lengthAB = edgeLength(positionData, vertexIdxA, vertexIdxB);
      const lengthBC = edgeLength(positionData, vertexIdxB, vertexIdxC);
      const lengthCA = edgeLength(positionData, vertexIdxC, vertexIdxA);
      if (Math.max(lengthAB, lengthBC, lengthCA) <= edgeBudget) {
        pushOutward(finishedIndices, positionData, vertexIdxA, vertexIdxB, vertexIdxC);
        continue;
      }
      if (lengthAB >= lengthBC && lengthAB >= lengthCA) {
        const midIndex = midpointOf(vertexIdxA, vertexIdxB);
        pushOutward(nextActive, positionData, vertexIdxA, midIndex, vertexIdxC);
        pushOutward(nextActive, positionData, midIndex, vertexIdxB, vertexIdxC);
      } else if (lengthBC >= lengthAB && lengthBC >= lengthCA) {
        const midIndex = midpointOf(vertexIdxB, vertexIdxC);
        pushOutward(nextActive, positionData, vertexIdxA, vertexIdxB, midIndex);
        pushOutward(nextActive, positionData, vertexIdxA, midIndex, vertexIdxC);
      } else {
        const midIndex = midpointOf(vertexIdxC, vertexIdxA);
        pushOutward(nextActive, positionData, vertexIdxA, vertexIdxB, midIndex);
        pushOutward(nextActive, positionData, vertexIdxB, vertexIdxC, midIndex);
      }
    }
    activeIndices = nextActive;
    if (!activeIndices.length) break;
  }

  indexList.length = 0;
  for (let listIndex = 0; listIndex < finishedIndices.length; listIndex++) indexList.push(finishedIndices[listIndex]);
  for (let listIndex = 0; listIndex < activeIndices.length; listIndex++) indexList.push(activeIndices[listIndex]);
  return { maxEdgeLength: longestEdge(positionData, indexList) };
}
