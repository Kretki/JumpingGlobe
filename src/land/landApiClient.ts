/** HTTP side of land loading: request URLs and streamed downloads with progress. */

import { clampValue } from "../geodesy/angleMath";
import type { BoundingBox } from "./boundingBox";

/** View cap at an age, for /api/land/past. */
export type PastQuery = { ageInMyr: number; centerLon: number; centerLat: number; radiusDeg: number };

export type DownloadProgressFn = (percentDone: number, labelText: string) => void;

const PROGRESS_INTERVAL_MS = 50;
const FETCH_SHARE_PERCENT = 35;
const BYTES_PER_MB = 1e6;

/**
 * Build the URL of a land request.
 *
 * Usage: one per load. Query names (file, bbox, age, lon, lat, radius, limit,
 * min_area) are the server API's parameter names.
 *
 * @param apiBaseUrl - API prefix without trailing slash, e.g. "/api".
 * @param fileName - GeoPackage file name.
 * @param requestBounds - Box for /land (ignored for past queries).
 * @param featureLimit - Maximum number of features.
 * @param minAreaDeg2 - Minimum envelope area in deg².
 * @param pastQuery - When set, request /land/past for this cap instead.
 * @returns Relative URL with an encoded query string.
 */
export function buildLandUrl(
  apiBaseUrl: string,
  fileName: string,
  requestBounds: BoundingBox,
  featureLimit: number,
  minAreaDeg2: number,
  pastQuery?: PastQuery
): string {
  const queryParams = pastQuery
    ? new URLSearchParams({
        file: fileName,
        age: String(pastQuery.ageInMyr),
        lon: String(pastQuery.centerLon),
        lat: String(pastQuery.centerLat),
        radius: String(pastQuery.radiusDeg),
        limit: String(featureLimit),
        min_area: String(minAreaDeg2),
      })
    : new URLSearchParams({
        file: fileName,
        bbox: `${requestBounds.westEdge},${requestBounds.southEdge},${requestBounds.eastEdge},${requestBounds.northEdge}`,
        limit: String(featureLimit),
        min_area: String(minAreaDeg2),
      });
  return `${apiBaseUrl}/land${pastQuery ? "/past" : ""}?${queryParams}`;
}

/**
 * Map downloaded bytes to the 0–35 % share of a load's progress bar.
 *
 * Usage: download progress.
 *
 * @param receivedBytes - Bytes received so far.
 * @param totalBytes - Content-Length, or null when unknown.
 * @returns Percent (asymptotic to 30 % when the size is unknown).
 */
export function fetchPercent(receivedBytes: number, totalBytes: number | null): number {
  if (totalBytes && totalBytes > 0) return clampValue((receivedBytes / totalBytes) * FETCH_SHARE_PERCENT, 0, FETCH_SHARE_PERCENT);
  return clampValue(30 * (1 - Math.exp(-receivedBytes / 2e6)), 0, 30);
}

/**
 * Map meshed features to the 40–95 % share of a load's progress bar.
 *
 * Usage: mesh progress.
 *
 * @param doneCount - Features meshed.
 * @param totalCount - Features to mesh.
 * @returns Percent.
 */
export function meshPercent(doneCount: number, totalCount: number): number {
  const doneFraction = totalCount > 0 ? doneCount / totalCount : 1;
  return 40 + doneFraction * 55;
}

/**
 * Read a response body as UTF-8 text, reporting download progress.
 *
 * Usage: land responses are megabytes; the progress bar follows the download.
 *
 * @param httpResponse - Fetch response.
 * @param abortSignal - Aborts the read.
 * @param onProgress - Receives (percent, label) at most every 50 ms and once at the end.
 * @returns The decoded body.
 * @throws DOMException "AbortError" when aborted.
 */
export async function readBodyWithProgress(
  httpResponse: Response,
  abortSignal: AbortSignal,
  onProgress: DownloadProgressFn
): Promise<string> {
  const totalBytes = Number(httpResponse.headers.get("content-length")) || null;
  if (!httpResponse.body || typeof httpResponse.body.getReader !== "function") return await httpResponse.text();

  const bodyReader = httpResponse.body.getReader();
  const bodyChunks: Uint8Array[] = [];
  let receivedBytes = 0;
  let lastEmitMs = 0;
  while (true) {
    if (abortSignal.aborted) throw new DOMException("Aborted", "AbortError");
    const { done: streamDone, value: chunkBytes } = await bodyReader.read();
    if (streamDone) break;
    if (!chunkBytes) continue;
    bodyChunks.push(chunkBytes);
    receivedBytes += chunkBytes.byteLength;
    const nowMillis = Date.now();
    if (nowMillis - lastEmitMs >= PROGRESS_INTERVAL_MS) {
      lastEmitMs = nowMillis;
      const receivedMb = (receivedBytes / BYTES_PER_MB).toFixed(1);
      const labelText = totalBytes
        ? `Downloading ${receivedMb}/${(totalBytes / BYTES_PER_MB).toFixed(1)} MB`
        : `Downloading ${receivedMb} MB`;
      onProgress(Math.round(fetchPercent(receivedBytes, totalBytes)), labelText);
    }
  }
  onProgress(FETCH_SHARE_PERCENT, `Downloaded ${(receivedBytes / BYTES_PER_MB).toFixed(1)} MB`);

  const mergedBytes = new Uint8Array(receivedBytes);
  let writeOffset = 0;
  for (const chunkBytes of bodyChunks) {
    mergedBytes.set(chunkBytes, writeOffset);
    writeOffset += chunkBytes.byteLength;
  }
  return new TextDecoder("utf-8").decode(mergedBytes);
}
