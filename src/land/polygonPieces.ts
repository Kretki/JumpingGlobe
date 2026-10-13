/** Turn a GeoJSON polygon (exterior + holes) into simple, chart-ready pieces. */

import type { LonLatPoint } from "../geodesy/wgs84Ellipsoid";
import { splitRingAntimeridian, stripClosingVertex, unwrapRingLons, unwrappedLonSpan } from "./antimeridianSplit";
import { noteDegenerate, type MeshStats, type PolygonPiece } from "./meshTypes";
import { ringEnclosesPole } from "./poleDetection";
import { dedupeVertices, dropCollinearVertices, pointInRing } from "./ringGeometry";

/**
 * Split the exterior into rings no wider than 180° (unless it encloses a pole).
 *
 * Usage: first step of preparePolygonPieces.
 *
 * @param exteriorInput - Open exterior ring.
 * @param meshStats - Statistics (poleHandled, datelineSplits) to update.
 * @returns Tuple of (exterior rings, pole enclosed by the original exterior).
 */
function prepareExteriors(exteriorInput: LonLatPoint[], meshStats: MeshStats): [LonLatPoint[][], ReturnType<typeof ringEnclosesPole>] {
  const poleKind = ringEnclosesPole(exteriorInput);
  if (poleKind) {
    // Prefer a single ring + polar chart (no meridian surgery unless needed).
    meshStats.poleHandled++;
    return [[unwrapRingLons(exteriorInput)], poleKind];
  }
  const unwrappedRing = unwrapRingLons(exteriorInput);
  if (unwrappedLonSpan(unwrappedRing) > 180) {
    const splitParts = splitRingAntimeridian(exteriorInput);
    meshStats.datelineSplits += Math.max(0, splitParts.length);
    return [splitParts.length ? splitParts : [unwrappedRing], poleKind];
  }
  return [[unwrappedRing], poleKind];
}

/**
 * Holes whose vertex centroid lies inside an exterior (unwrapped lon/lat approximation).
 *
 * Usage: assign holes to the exterior pieces of a split polygon.
 *
 * @param exteriorRing - Deduplicated exterior ring.
 * @param holeInputs - Unwrapped hole rings.
 * @returns Deduplicated holes belonging to this exterior.
 */
function holesInside(exteriorRing: LonLatPoint[], holeInputs: LonLatPoint[][]): LonLatPoint[][] {
  const ownedHoles: LonLatPoint[][] = [];
  for (const holeRing of holeInputs) {
    if (holeRing.length < 3) continue;
    let centroidX = 0;
    let centroidY = 0;
    for (const holePoint of holeRing) {
      centroidX += holePoint[0];
      centroidY += holePoint[1];
    }
    centroidX /= holeRing.length;
    centroidY /= holeRing.length;
    if (pointInRing(centroidX, centroidY, exteriorRing)) ownedHoles.push(dedupeVertices(holeRing));
  }
  return ownedHoles;
}

/**
 * Prepare a GeoJSON polygon's rings into simple chart-ready pieces.
 *
 * Usage: called for every Polygon (and MultiPolygon member) before clipping and triangulation.
 *
 * @param polygonRings - GeoJSON rings: exterior first, then holes.
 * @param meshStats - Statistics to update.
 * @returns Pieces with exterior, holes and pole flag; empty for degenerate input.
 */
export function preparePolygonPieces(polygonRings: number[][][], meshStats: MeshStats): PolygonPiece[] {
  if (!polygonRings.length) return [];
  const exteriorInput = dropCollinearVertices(stripClosingVertex(polygonRings[0]));
  if (exteriorInput.length < 3) {
    noteDegenerate(meshStats);
    return [];
  }

  const [exteriorRings, poleKind] = prepareExteriors(exteriorInput, meshStats);
  const holeInputs = polygonRings
    .slice(1)
    .map((holeCoords) => unwrapRingLons(dropCollinearVertices(stripClosingVertex(holeCoords))));

  const polygonPieces: PolygonPiece[] = [];
  for (const rawExterior of exteriorRings) {
    const exteriorRing = dedupeVertices(rawExterior);
    if (exteriorRing.length < 3) {
      noteDegenerate(meshStats);
      continue;
    }
    polygonPieces.push({
      exteriorRing,
      holeRings: holesInside(exteriorRing, holeInputs),
      // Re-detect the pole for chart choice on this piece.
      poleKind: poleKind ?? ringEnclosesPole(exteriorRing),
    });
  }
  return polygonPieces;
}
