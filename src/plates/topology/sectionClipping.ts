/**
 * Clip the sections of a topology against their neighbours, as GPlates does when it
 * resolves a topological polygon or line: every line section is cut where it crosses
 * the previous section (its start) and the next section (its end). Sections arrive
 * already oriented in traversal order (reverse flags applied). Point sections and
 * sections that do not cross a neighbour are kept whole; the polygon then simply
 * joins their end points.
 */

import type { UnitVector } from "../sphericalCoords";
import { intersectPolylines, slicePolyline, type PolylineHit } from "./arcIntersection";

const MIN_PARAM_SPAN = 1e-9;

/** The kept piece of a section and where it lies along the oriented section (params, see arcIntersection). */
export type ClippedSection = { clippedUnits: UnitVector[]; startParam: number; endParam: number };

/**
 * Neighbour index of a section.
 *
 * Usage: previous/next lookups.
 *
 * @param sectionIdx - Section index.
 * @param stepOffset - -1 for the previous, +1 for the next section.
 * @param sectionCount - Number of sections.
 * @param isClosed - Whether the sections form a ring (polygon) or an open chain (line).
 * @returns The neighbour index, or -1 when there is none.
 */
function neighbourIndex(sectionIdx: number, stepOffset: number, sectionCount: number, isClosed: boolean): number {
  const rawIndex = sectionIdx + stepOffset;
  if (isClosed) return (rawIndex + sectionCount) % sectionCount;
  return rawIndex >= 0 && rawIndex < sectionCount ? rawIndex : -1;
}

/**
 * Crossings of every section with its next section.
 *
 * Usage: computed once per pair and used from both sides.
 *
 * @param sectionPoints - Oriented sections.
 * @param isClosed - Ring or open chain.
 * @returns Hits per section index (params: first = this section, second = next section).
 */
function nextNeighbourHits(sectionPoints: UnitVector[][], isClosed: boolean): PolylineHit[][] {
  return sectionPoints.map((currentPoints, sectionIdx) => {
    const nextIndex = neighbourIndex(sectionIdx, 1, sectionPoints.length, isClosed);
    if (nextIndex < 0 || nextIndex === sectionIdx) return [];
    return intersectPolylines(currentPoints, sectionPoints[nextIndex]);
  });
}

/**
 * Params of the kept piece of one line section.
 *
 * Usage: per line section.
 *
 * @param sectionIdx - Section index.
 * @param sectionPoints - Oriented sections.
 * @param pairHits - Result of nextNeighbourHits.
 * @param isClosed - Ring or open chain.
 * @returns [start param, end param]; the whole section when no usable crossing exists.
 */
function keptRange(sectionIdx: number, sectionPoints: UnitVector[][], pairHits: PolylineHit[][], isClosed: boolean): [number, number] {
  const lastParam = sectionPoints[sectionIdx].length - 1;
  const previousIdx = neighbourIndex(sectionIdx, -1, sectionPoints.length, isClosed);
  const previousHits = previousIdx >= 0 && previousIdx !== sectionIdx ? pairHits[previousIdx] : [];
  // Seen from this section the crossings with the previous one are the "second" params.
  const startParam = previousHits.length ? Math.min(...previousHits.map((pairedHit) => pairedHit.secondParam)) : 0;
  const laterHits = pairHits[sectionIdx].filter((pairedHit) => pairedHit.firstParam > startParam + MIN_PARAM_SPAN);
  const endParam = laterHits.length ? laterHits[laterHits.length - 1].firstParam : lastParam;
  return endParam - startParam > MIN_PARAM_SPAN ? [startParam, endParam] : [0, lastParam];
}

/**
 * Clip every section of a topology against its neighbours.
 *
 * Usage: resolving topological polygons (closed) and topological lines (open).
 *
 * @param sectionPoints - Oriented sections: polylines (≥ 2 points) or single points.
 * @param isClosed - True for a polygon (the last section neighbours the first).
 * @returns The kept piece of each section with its param range, in the same order and orientation.
 */
export function clipSections(sectionPoints: UnitVector[][], isClosed: boolean): ClippedSection[] {
  const pairHits = nextNeighbourHits(sectionPoints, isClosed);
  return sectionPoints.map((currentPoints, sectionIdx) => {
    if (currentPoints.length < 2) return { clippedUnits: currentPoints, startParam: 0, endParam: 0 };
    const [startParam, endParam] = keptRange(sectionIdx, sectionPoints, pairHits, isClosed);
    const isWholeLine = startParam === 0 && endParam === currentPoints.length - 1;
    return { clippedUnits: isWholeLine ? currentPoints : slicePolyline(currentPoints, startParam, endParam), startParam, endParam };
  });
}
