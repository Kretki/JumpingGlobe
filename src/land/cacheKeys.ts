/** Cache keys of loaded land views, and the "already covered" test between them. */

import { boundsContain, type BoundingBox } from "./boundingBox";
import type { PastQuery } from "./landApiClient";

type ParsedKey = { fileName: string; keyBounds: BoundingBox; minAreaText: string };

/**
 * Key of a present-day view request.
 *
 * Usage: LRU cache key; coordinates are rounded to 0.01°.
 *
 * @param requestBounds - Requested box.
 * @param fileName - GeoPackage file name.
 * @param minAreaDeg2 - Minimum envelope area in deg².
 * @returns "file|w,s,e,n|minAreaDeg2".
 */
export function boundsKey(requestBounds: BoundingBox, fileName: string, minAreaDeg2: number): string {
  const roundCoord = (coordValue: number) => coordValue.toFixed(2);
  return (
    `${fileName}|${roundCoord(requestBounds.westEdge)},${roundCoord(requestBounds.southEdge)},` +
    `${roundCoord(requestBounds.eastEdge)},${roundCoord(requestBounds.northEdge)}|${minAreaDeg2.toFixed(4)}`
  );
}

/**
 * Key of a past-age request.
 *
 * Usage: LRU cache key for /land/past results.
 *
 * @param fileName - Plate-tagged GeoPackage.
 * @param pastQuery - View cap and age.
 * @returns "past|file|age|lon,lat|radius".
 */
export function pastCacheKey(fileName: string, pastQuery: PastQuery): string {
  return (
    `past|${fileName}|${pastQuery.ageInMyr}|${pastQuery.centerLon.toFixed(3)},` +
    `${pastQuery.centerLat.toFixed(3)}|${pastQuery.radiusDeg.toFixed(3)}`
  );
}

/**
 * Parse a key produced by boundsKey.
 *
 * Usage: compare cached views.
 *
 * @param cacheKey - Key string.
 * @returns Its parts, or null for keys of another shape.
 */
function parseBoundsKey(cacheKey: string): ParsedKey | null {
  const keyParts = cacheKey.split("|");
  if (keyParts.length < 3) return null;
  const coordValues = keyParts[1].split(",").map(Number);
  if (coordValues.length < 4 || coordValues.some((coordValue) => !Number.isFinite(coordValue))) return null;
  return {
    fileName: keyParts[0],
    keyBounds: { westEdge: coordValues[0], southEdge: coordValues[1], eastEdge: coordValues[2], northEdge: coordValues[3] },
    minAreaText: keyParts[2],
  };
}

/**
 * Whether a cached view already covers a new request.
 *
 * Usage: skip refetching for small pans.
 *
 * @param cachedKey - Key of the cached view.
 * @param requestedKey - Key of the new request.
 * @returns True for the same file and min area with the new box inside the cached one.
 */
export function keyCovers(cachedKey: string, requestedKey: string): boolean {
  const cachedParts = parseBoundsKey(cachedKey);
  const requestedParts = parseBoundsKey(requestedKey);
  if (!cachedParts || !requestedParts) return false;
  if (cachedParts.fileName !== requestedParts.fileName || cachedParts.minAreaText !== requestedParts.minAreaText) return false;
  return boundsContain(cachedParts.keyBounds, requestedParts.keyBounds, 0);
}
