/** Mesh a pole-enclosing ring as concentric latitude bands (no earcut, no Rivara explosion). */

import { normalizeLonLat } from "../geodesy/angleMath";
import { WGS84_SEMI_MAJOR, type LonLatPoint } from "../geodesy/wgs84Ellipsoid";
import { noteDegenerate, noteReason, type MeshStats, type TriangulatedPiece } from "./meshTypes";

/** Metres per degree of latitude (approximate). */
const METERS_PER_DEG_LAT = 111320;
const MIN_AZIMUTH_STEPS = 12;

/**
 * Lon/lat vertices of the cap: the pole, intermediate parallels, then the exterior.
 *
 * Usage: first step of meshPolarCap.
 *
 * @param exteriorRing - Boundary ring.
 * @param poleLatitude - ±90.
 * @param boundaryLat - Mean latitude of the boundary.
 * @param bandCount - Number of latitude bands.
 * @param azimuthSteps - Vertices per intermediate parallel.
 * @returns Tuple (vertex lon/lats, start index of every ring; ring 0 is the pole).
 */
function capVertices(
  exteriorRing: LonLatPoint[],
  poleLatitude: number,
  boundaryLat: number,
  bandCount: number,
  azimuthSteps: number
): [LonLatPoint[], number[]] {
  const vertexLonLats: LonLatPoint[] = [[0, poleLatitude]];
  const ringStarts: number[] = [0];
  for (let bandIndex = 1; bandIndex <= bandCount; bandIndex++) {
    ringStarts.push(vertexLonLats.length);
    const bandFraction = bandIndex / bandCount;
    const bandLatitude = poleLatitude + bandFraction * (boundaryLat - poleLatitude);
    if (bandIndex === bandCount) {
      // The last ring uses the actual exterior samples.
      for (const ringPoint of exteriorRing) vertexLonLats.push(normalizeLonLat(ringPoint));
    } else {
      for (let azimuthIdx = 0; azimuthIdx < azimuthSteps; azimuthIdx++) {
        vertexLonLats.push([-180 + (azimuthIdx / azimuthSteps) * 360, bandLatitude]);
      }
    }
  }
  return [vertexLonLats, ringStarts];
}

/**
 * Triangles of the cap: a fan around the pole and quad strips between rings.
 *
 * Usage: second step of meshPolarCap.
 *
 * @param ringStarts - Start index of every ring.
 * @param vertexCount - Total vertex count.
 * @param bandCount - Number of latitude bands.
 * @param isSouthPole - Winding flips for the south pole.
 * @returns Flat triangle index list.
 */
function capTriangles(ringStarts: number[], vertexCount: number, bandCount: number, isSouthPole: boolean): number[] {
  const triangleList: number[] = [];
  const firstStart = ringStarts[1];
  const firstCount = (ringStarts[2] ?? vertexCount) - firstStart;
  for (let azimuthIdx = 0; azimuthIdx < firstCount; azimuthIdx++) {
    const currentVertex = firstStart + azimuthIdx;
    const nextVertex = firstStart + ((azimuthIdx + 1) % firstCount);
    if (isSouthPole) triangleList.push(0, currentVertex, nextVertex);
    else triangleList.push(0, nextVertex, currentVertex);
  }
  for (let bandIndex = 1; bandIndex < bandCount; bandIndex++) {
    const innerStart = ringStarts[bandIndex];
    const outerStart = ringStarts[bandIndex + 1];
    const innerCount = (ringStarts[bandIndex + 1] ?? vertexCount) - innerStart;
    const outerCount = (ringStarts[bandIndex + 2] ?? vertexCount) - outerStart;
    // Both rings match azimuthSteps except the last, which may be the exterior.
    const stripCount = Math.min(innerCount, outerCount);
    if (stripCount < 3) continue;
    for (let stripIdx = 0; stripIdx < stripCount; stripIdx++) {
      const innerVertexA = innerStart + (Math.floor((stripIdx / stripCount) * innerCount) % innerCount);
      const innerVertexB = innerStart + (Math.floor(((stripIdx + 1) / stripCount) * innerCount) % innerCount);
      const outerVertexA = outerStart + (Math.floor((stripIdx / stripCount) * outerCount) % outerCount);
      const outerVertexB = outerStart + (Math.floor(((stripIdx + 1) / stripCount) * outerCount) % outerCount);
      if (isSouthPole) {
        triangleList.push(innerVertexA, outerVertexA, outerVertexB);
        triangleList.push(innerVertexA, outerVertexB, innerVertexB);
      } else {
        triangleList.push(innerVertexA, outerVertexB, outerVertexA);
        triangleList.push(innerVertexA, innerVertexB, outerVertexB);
      }
    }
  }
  return triangleList;
}

/**
 * Mesh a polar-enclosing ring as concentric latitude bands filled toward the pole.
 *
 * Usage: replaces earcut for Antarctica-like rings.
 *
 * @param exteriorRing - Densified boundary ring.
 * @param poleKind - Enclosed pole.
 * @param maxEdgeMeters - Target edge length.
 * @param meshStats - Statistics to update.
 * @returns Vertices and triangles, or null for degenerate rings.
 */
export function meshPolarCap(
  exteriorRing: LonLatPoint[],
  poleKind: "north" | "south",
  maxEdgeMeters: number,
  meshStats: MeshStats
): TriangulatedPiece | null {
  if (exteriorRing.length < 3) {
    noteDegenerate(meshStats);
    return null;
  }
  let latitudeSum = 0;
  for (const ringPoint of exteriorRing) latitudeSum += ringPoint[1];
  const boundaryLat = latitudeSum / exteriorRing.length;
  const poleLatitude = poleKind === "north" ? 90 : -90;
  const latSpanDeg = Math.abs(poleLatitude - boundaryLat);
  if (latSpanDeg < 1e-6) {
    noteDegenerate(meshStats);
    return null;
  }

  const bandCount = Math.max(1, Math.ceil((latSpanDeg * METERS_PER_DEG_LAT) / maxEdgeMeters));
  // Azimuth resolution from the boundary parallel's circumference.
  const boundaryLatRad = (Math.abs(boundaryLat) * Math.PI) / 180;
  const parallelRadius = WGS84_SEMI_MAJOR * Math.cos(boundaryLatRad);
  const circumference = 2 * Math.PI * Math.max(parallelRadius, 1);
  const azimuthSteps = Math.max(exteriorRing.length, Math.ceil(circumference / maxEdgeMeters), MIN_AZIMUTH_STEPS);

  const [vertexLonLats, ringStarts] = capVertices(exteriorRing, poleLatitude, boundaryLat, bandCount, azimuthSteps);
  const triangleList = capTriangles(ringStarts, vertexLonLats.length, bandCount, poleKind === "south");
  if (!triangleList.length) {
    meshStats.earcutEmpty++;
    noteReason(meshStats, "earcut_empty");
    return null;
  }
  return { vertexLonLats, triangleList };
}
