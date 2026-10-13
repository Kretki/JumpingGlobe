/**
 * Exact polygon ∩ axis-aligned rectangle (Weiler–Atherton specialised to a rect).
 *
 * Sutherland–Hodgman returns ONE ring per input ring: separate pieces of land stay
 * linked by zero-width "bridge" edges along the rect border, and earcut fills the
 * water between them. Here every inside run of the exterior/holes is cut out and
 * runs are re-joined only by walking the rect border CCW from an exit to the next
 * entry, so each disjoint piece becomes its own polygon.
 */

import { unwrapLongitudeNear } from "../geodesy/angleMath";
import type { LonLatPoint } from "../geodesy/wgs84Ellipsoid";
import { splitAtAntimeridian, type BoundingBox } from "./boundingBox";
import type { PolygonPiece } from "./meshTypes";
import { ringEnclosesPole } from "./poleDetection";
import { capRingVertices, dedupeVertices, lerpLonLat, pointInRing, ringSignedArea } from "./ringGeometry";

// Safety cap only: index-subsampling a ring distorts the coastline, so it must
// never trigger for real data (earcut handles rings of this size fine).
const MAX_RING_VERTS = 200_000;

/** Rect sides, numbered by their position on the CCW perimeter walk. */
const SIDE_SOUTH = 0;
const SIDE_EAST = 1;
const SIDE_NORTH = 2;
const SIDE_WEST = 3;

type BoundaryHit = { hitPoint: LonLatPoint; perimeter: number };
type ClipChain = { chainPoints: LonLatPoint[]; entryCrossing: BoundaryHit; exitCrossing: BoundaryHit; isConsumed: boolean };
type SegmentClip = { enterParam: number; exitParam: number; enterSide: number; exitSide: number };
type ClippedPolygon = { exteriorRing: LonLatPoint[]; holeRings: LonLatPoint[][] };

/**
 * CCW perimeter coordinate (from the SW corner) of a point on a rect side.
 *
 * Usage: order boundary crossings along the rect border.
 *
 * @param borderPoint - Point on the side.
 * @param sideIndex - SIDE_* constant.
 * @param clipRect - Rectangle (westEdge <= eastEdge).
 * @returns Distance along the perimeter in degrees.
 */
function perimeterPosition(borderPoint: LonLatPoint, sideIndex: number, clipRect: BoundingBox): number {
  const rectWidth = clipRect.eastEdge - clipRect.westEdge;
  const rectHeight = clipRect.northEdge - clipRect.southEdge;
  const clampSpan = (spanValue: number, spanLimit: number) => Math.max(0, Math.min(spanLimit, spanValue));
  if (sideIndex === SIDE_SOUTH) return clampSpan(borderPoint[0] - clipRect.westEdge, rectWidth);
  if (sideIndex === SIDE_EAST) return rectWidth + clampSpan(borderPoint[1] - clipRect.southEdge, rectHeight);
  if (sideIndex === SIDE_NORTH) return rectWidth + rectHeight + clampSpan(clipRect.eastEdge - borderPoint[0], rectWidth);
  return 2 * rectWidth + rectHeight + clampSpan(clipRect.northEdge - borderPoint[1], rectHeight);
}

/**
 * Point at a fraction of segment start→end, snapped exactly onto a rect side.
 *
 * Usage: entry/exit points, so perimeter positions are exact.
 *
 * @param startPoint - Segment start.
 * @param endPoint - Segment end.
 * @param fraction - Parameter of the crossing.
 * @param sideIndex - Side that is crossed.
 * @param clipRect - Rectangle.
 * @returns The crossing and its perimeter position.
 */
function boundaryHit(
  startPoint: LonLatPoint,
  endPoint: LonLatPoint,
  fraction: number,
  sideIndex: number,
  clipRect: BoundingBox
): BoundaryHit {
  const hitPoint = lerpLonLat(startPoint, endPoint, fraction);
  if (sideIndex === SIDE_WEST) hitPoint[0] = clipRect.westEdge;
  else if (sideIndex === SIDE_EAST) hitPoint[0] = clipRect.eastEdge;
  else if (sideIndex === SIDE_SOUTH) hitPoint[1] = clipRect.southEdge;
  else hitPoint[1] = clipRect.northEdge;
  return { hitPoint, perimeter: perimeterPosition(hitPoint, sideIndex, clipRect) };
}

/**
 * Liang–Barsky: parametric range of segment start→end inside the rect (inclusive)
 * plus the sides that bound it.
 *
 * Usage: per ring edge while extracting inside runs.
 *
 * @param startPoint - Segment start.
 * @param endPoint - Segment end.
 * @param clipRect - Rectangle.
 * @returns The clippedPolygon range (side −1 = segment end lies inside), or null when the segment misses.
 */
function clipSegment(startPoint: LonLatPoint, endPoint: LonLatPoint, clipRect: BoundingBox): SegmentClip | null {
  const deltaAlongX = endPoint[0] - startPoint[0];
  const deltaAlongY = endPoint[1] - startPoint[1];
  const directionTerms = [-deltaAlongX, deltaAlongX, -deltaAlongY, deltaAlongY];
  const distanceTerms = [
    startPoint[0] - clipRect.westEdge,
    clipRect.eastEdge - startPoint[0],
    startPoint[1] - clipRect.southEdge,
    clipRect.northEdge - startPoint[1],
  ];
  const sideOrder = [SIDE_WEST, SIDE_EAST, SIDE_SOUTH, SIDE_NORTH];
  let enterParam = 0;
  let exitParam = 1;
  let enterSide = -1;
  let exitSide = -1;
  for (let termIndex = 0; termIndex < 4; termIndex++) {
    if (directionTerms[termIndex] === 0) {
      if (distanceTerms[termIndex] < 0) return null;
      continue;
    }
    const crossParam = distanceTerms[termIndex] / directionTerms[termIndex];
    if (directionTerms[termIndex] < 0) {
      if (crossParam > enterParam) {
        enterParam = crossParam;
        enterSide = sideOrder[termIndex];
      }
    } else if (crossParam < exitParam) {
      exitParam = crossParam;
      exitSide = sideOrder[termIndex];
    }
  }
  if (enterParam > exitParam) return null;
  return { enterParam, exitParam, enterSide, exitSide };
}

/**
 * Test whether a point lies inside a rect (edges inclusive).
 *
 * Usage: find a ring vertex outside the rect to start the walk from.
 *
 * @param testPoint - Point.
 * @param clipRect - Rectangle.
 * @returns True when inside.
 */
function insideRect(testPoint: LonLatPoint, clipRect: BoundingBox): boolean {
  return (
    testPoint[0] >= clipRect.westEdge &&
    testPoint[0] <= clipRect.eastEdge &&
    testPoint[1] >= clipRect.southEdge &&
    testPoint[1] <= clipRect.northEdge
  );
}

/**
 * Side of a rect nearest to a point.
 *
 * Usage: perimeter position of a vertex lying exactly on the border.
 *
 * @param testPoint - Point.
 * @param clipRect - Rectangle.
 * @returns SIDE_* constant.
 */
function nearestSide(testPoint: LonLatPoint, clipRect: BoundingBox): number {
  const sideDistances = [
    testPoint[1] - clipRect.southEdge,
    clipRect.eastEdge - testPoint[0],
    clipRect.northEdge - testPoint[1],
    testPoint[0] - clipRect.westEdge,
  ];
  let bestSide = 0;
  for (let sideIndex = 1; sideIndex < 4; sideIndex++) if (sideDistances[sideIndex] < sideDistances[bestSide]) bestSide = sideIndex;
  return bestSide;
}

/**
 * Cut a closed ring into the runs that lie inside the rect.
 *
 * Usage: first phase of clipPolygonToRect.
 *
 * @param ringPoints - Open ring.
 * @param clipRect - Rectangle.
 * @returns null when the whole ring is inside (keep it as-is); [] when nothing is inside.
 */
function ringChains(ringPoints: LonLatPoint[], clipRect: BoundingBox): ClipChain[] | null {
  const pointCount = ringPoints.length;
  let startIdx = -1;
  for (let pointIdx = 0; pointIdx < pointCount; pointIdx++) {
    if (!insideRect(ringPoints[pointIdx], clipRect)) {
      startIdx = pointIdx;
      break;
    }
  }
  if (startIdx < 0) return null;

  const chainList: ClipChain[] = [];
  let openChain: { chainPoints: LonLatPoint[]; entryCrossing: BoundaryHit } | null = null;
  for (let stepIndex = 0; stepIndex < pointCount; stepIndex++) {
    const startPoint = ringPoints[(startIdx + stepIndex) % pointCount];
    const endPoint = ringPoints[(startIdx + stepIndex + 1) % pointCount];
    const segmentClip = clipSegment(startPoint, endPoint, clipRect);
    if (!segmentClip) continue;
    if (segmentClip.enterSide >= 0 || !openChain) {
      // startPoint is outside (or exactly on the boundary after an exit): the ring enters here.
      const entryCrossing =
        segmentClip.enterSide >= 0
          ? boundaryHit(startPoint, endPoint, segmentClip.enterParam, segmentClip.enterSide, clipRect)
          : { hitPoint: startPoint, perimeter: perimeterPosition(startPoint, nearestSide(startPoint, clipRect), clipRect) };
      openChain = { chainPoints: [entryCrossing.hitPoint], entryCrossing };
    }
    if (segmentClip.exitSide >= 0) {
      const exitCrossing = boundaryHit(startPoint, endPoint, segmentClip.exitParam, segmentClip.exitSide, clipRect);
      openChain.chainPoints.push(exitCrossing.hitPoint);
      const chainPoints = dedupeVertices(openChain.chainPoints);
      // Runs that only touch the boundary at a point enclose nothing.
      if (chainPoints.length >= 2) chainList.push({ chainPoints, entryCrossing: openChain.entryCrossing, exitCrossing, isConsumed: false });
      openChain = null;
    } else {
      openChain.chainPoints.push(endPoint);
    }
  }
  return chainList;
}

/**
 * Re-join inside runs into closed exterior rings by walking the rect border CCW.
 *
 * Usage: second phase of clipPolygonToRect.
 *
 * @param chainList - Inside runs of the exterior and crossing holes.
 * @param clipRect - Rectangle.
 * @returns Closed CCW exterior rings.
 */
function joinChains(chainList: ClipChain[], clipRect: BoundingBox): LonLatPoint[][] {
  const rectWidth = clipRect.eastEdge - clipRect.westEdge;
  const rectHeight = clipRect.northEdge - clipRect.southEdge;
  const perimeterLength = 2 * rectWidth + 2 * rectHeight;
  const cornerList: { perimeter: number; cornerPoint: LonLatPoint }[] = [
    { perimeter: rectWidth, cornerPoint: [clipRect.eastEdge, clipRect.southEdge] },
    { perimeter: rectWidth + rectHeight, cornerPoint: [clipRect.eastEdge, clipRect.northEdge] },
    { perimeter: 2 * rectWidth + rectHeight, cornerPoint: [clipRect.westEdge, clipRect.northEdge] },
    { perimeter: perimeterLength, cornerPoint: [clipRect.westEdge, clipRect.southEdge] },
  ];
  const ccwDistance = (fromPerimeter: number, toPerimeter: number) => {
    const rawDistance = (toPerimeter - fromPerimeter) % perimeterLength;
    return rawDistance < 0 ? rawDistance + perimeterLength : rawDistance;
  };
  const nextChainFrom = (fromPerimeter: number): ClipChain => {
    let bestChain = chainList[0];
    let bestDistance = Infinity;
    for (const clipChain of chainList) {
      const chainDistance = ccwDistance(fromPerimeter, clipChain.entryCrossing.perimeter);
      if (chainDistance < bestDistance) {
        bestDistance = chainDistance;
        bestChain = clipChain;
      }
    }
    return bestChain;
  };

  const exteriorRings: LonLatPoint[][] = [];
  for (const firstChain of chainList) {
    if (firstChain.isConsumed) continue;
    const joinedRing: LonLatPoint[] = [];
    let currentChain = firstChain;
    for (let guardCount = 0; guardCount <= chainList.length; guardCount++) {
      currentChain.isConsumed = true;
      for (const chainPoint of currentChain.chainPoints) joinedRing.push(chainPoint);
      const nextChain = nextChainFrom(currentChain.exitCrossing.perimeter);
      const walkSpan = ccwDistance(currentChain.exitCrossing.perimeter, nextChain.entryCrossing.perimeter);
      const exitPosition = currentChain.exitCrossing.perimeter;
      const passedCorners = cornerList
        .map((cornerEntry) => ({ walkDistance: ccwDistance(exitPosition, cornerEntry.perimeter), cornerPoint: cornerEntry.cornerPoint }))
        .filter((cornerEntry) => cornerEntry.walkDistance > 0 && cornerEntry.walkDistance < walkSpan)
        .sort((firstCorner, secondCorner) => firstCorner.walkDistance - secondCorner.walkDistance);
      for (const cornerEntry of passedCorners) joinedRing.push([cornerEntry.cornerPoint[0], cornerEntry.cornerPoint[1]]);
      if (nextChain === firstChain || nextChain.isConsumed) break;
      currentChain = nextChain;
    }
    const cleanRing = dedupeVertices(joinedRing);
    if (cleanRing.length >= 3 && ringSignedArea(cleanRing) > 0) exteriorRings.push(cleanRing);
  }
  return exteriorRings;
}

/**
 * Exact polygon ∩ rect.
 *
 * Usage: clip view-detail polygons to the requested box.
 *
 * @param exteriorInput - Exterior ring (any orientation).
 * @param holeInputs - Hole rings (any orientation).
 * @param clipRect - Rectangle (westEdge <= eastEdge, same longitude frame as the rings).
 * @returns Disjoint polygons (CCW exteriors, CW holes); empty when nothing is inside.
 */
export function clipPolygonToRect(
  exteriorInput: LonLatPoint[],
  holeInputs: LonLatPoint[][],
  clipRect: BoundingBox
): ClippedPolygon[] {
  // Exterior CCW / holes CW: land is always on the left of travel, so the border
  // walk from an exit to the next entry is CCW.
  const exteriorRing = ringSignedArea(exteriorInput) < 0 ? exteriorInput.slice().reverse() : exteriorInput;
  const holeRings = holeInputs
    .filter((holeRing) => holeRing.length >= 3)
    .map((holeRing) => (ringSignedArea(holeRing) > 0 ? holeRing.slice().reverse() : holeRing));

  const chainList: ClipChain[] = [];
  const insideHoles: LonLatPoint[][] = [];
  const crossingOrOutsideHoles: LonLatPoint[][] = [];

  const exteriorChains = ringChains(exteriorRing, clipRect);
  if (exteriorChains === null) {
    // Exterior fully inside ⇒ its holes are too.
    return [{ exteriorRing, holeRings }];
  }
  chainList.push(...exteriorChains);
  for (const holeRing of holeRings) {
    const holeChains = ringChains(holeRing, clipRect);
    if (holeChains === null) insideHoles.push(holeRing);
    else {
      chainList.push(...holeChains);
      crossingOrOutsideHoles.push(holeRing);
    }
  }

  let exteriorRings: LonLatPoint[][];
  if (!chainList.length) {
    // No boundary crossings: the rect is either entirely land or entirely water.
    const rectCenterX = (clipRect.westEdge + clipRect.eastEdge) / 2;
    const rectCenterY = (clipRect.southEdge + clipRect.northEdge) / 2;
    if (!pointInRing(rectCenterX, rectCenterY, exteriorRing)) return [];
    for (const holeRing of crossingOrOutsideHoles) {
      if (pointInRing(rectCenterX, rectCenterY, holeRing)) return [];
    }
    exteriorRings = [
      [
        [clipRect.westEdge, clipRect.southEdge],
        [clipRect.eastEdge, clipRect.southEdge],
        [clipRect.eastEdge, clipRect.northEdge],
        [clipRect.westEdge, clipRect.northEdge],
      ],
    ];
  } else {
    exteriorRings = joinChains(chainList, clipRect);
  }

  const clippedPolygons = exteriorRings.map((joinedRing) => ({ exteriorRing: joinedRing, holeRings: [] as LonLatPoint[][] }));
  for (const holeRing of insideHoles) {
    const ownerPolygon = clippedPolygons.find((clippedPolygon) => pointInRing(holeRing[0][0], holeRing[0][1], clippedPolygon.exteriorRing));
    if (ownerPolygon) ownerPolygon.holeRings.push(holeRing);
  }
  return clippedPolygons;
}

/**
 * Express a non-wrapping rect in the longitude frame of a ring.
 *
 * Usage: rings may be unwrapped beyond ±180°; the rect must follow them.
 *
 * @param clipRect - Rectangle in [-180, 180].
 * @param referenceLon - A longitude of the ring.
 * @returns Equivalent rect near referenceLon (latitude-only band for full-longitude rects).
 */
function rectInLonFrame(clipRect: BoundingBox, referenceLon: number): BoundingBox {
  // Full-longitude band (polar views): clip by latitude only, in any lon frame.
  if (clipRect.eastEdge - clipRect.westEdge >= 359.999) {
    return { westEdge: -1e9, southEdge: clipRect.southEdge, eastEdge: 1e9, northEdge: clipRect.northEdge };
  }
  const westEdge = unwrapLongitudeNear(clipRect.westEdge, referenceLon);
  let eastEdge = unwrapLongitudeNear(clipRect.eastEdge, referenceLon);
  if (eastEdge < westEdge) eastEdge += 360;
  return { westEdge, southEdge: clipRect.southEdge, eastEdge, northEdge: clipRect.northEdge };
}

/**
 * Clip a prepared polygon piece to a (possibly wrapping) box.
 *
 * Usage: detail meshes for a view box.
 *
 * @param polygonPiece - Piece from preparePolygonPieces.
 * @param clipBounds - Box, possibly wrapping the antimeridian.
 * @returns Clipped pieces with pole flags recomputed.
 */
export function clipPreparedPiece(polygonPiece: PolygonPiece, clipBounds: BoundingBox): PolygonPiece[] {
  const referenceLon = polygonPiece.exteriorRing[0][0];
  const clippedPieces: PolygonPiece[] = [];
  for (const rawClipRect of splitAtAntimeridian(clipBounds)) {
    let frameRect = rectInLonFrame(rawClipRect, referenceLon);
    if (frameRect.eastEdge - frameRect.westEdge > 720) {
      // Full-longitude band: clip by latitude only, with a finite rect around the ring.
      let minLongitude = Infinity;
      let maxLongitude = -Infinity;
      for (const ringPoint of polygonPiece.exteriorRing) {
        minLongitude = Math.min(minLongitude, ringPoint[0]);
        maxLongitude = Math.max(maxLongitude, ringPoint[0]);
      }
      frameRect = {
        westEdge: minLongitude - 1,
        southEdge: frameRect.southEdge,
        eastEdge: maxLongitude + 1,
        northEdge: frameRect.northEdge,
      };
    }
    for (const clippedPart of clipPolygonToRect(polygonPiece.exteriorRing, polygonPiece.holeRings, frameRect)) {
      const exteriorRing = capRingVertices(clippedPart.exteriorRing, MAX_RING_VERTS);
      if (exteriorRing.length < 3) continue;
      clippedPieces.push({
        exteriorRing,
        holeRings: clippedPart.holeRings.map((holeRing) => capRingVertices(holeRing, MAX_RING_VERTS)),
        poleKind: ringEnclosesPole(exteriorRing),
      });
    }
  }
  return clippedPieces;
}
