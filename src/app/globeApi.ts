/** Typed, validated access to the non-land API endpoints. */

import type { RotationModel } from "../plates/rotationTree";
import { parseStaticPolygons, type StaticFeatureCollection, type StaticPolygon } from "../plates/staticPolygons";

const API_PREFIX = "/api";
const PLATE_STATUSES = ["ready", "building", "failed", "unavailable"] as const;

export type PlateBuildStatus = (typeof PLATE_STATUSES)[number];

/** Body of /api/plates/status (member names are the API's). */
export type PlateStatusResponse = {
  status: PlateBuildStatus;
  detail: string;
  plateFiles: Record<string, string>;
  staticFile: string | null;
};

/**
 * GET a JSON document.
 *
 * Usage: shared by the fetchers below.
 *
 * @param requestPath - Path below the API prefix, with query string.
 * @returns The parsed body.
 * @throws Error on HTTP errors or invalid JSON.
 */
async function fetchJson(requestPath: string): Promise<unknown> {
  const httpResponse = await fetch(`${API_PREFIX}${requestPath}`);
  if (!httpResponse.ok) throw new Error(`HTTP ${httpResponse.status}`);
  return (await httpResponse.json()) as unknown;
}

/**
 * Narrow an unknown value to a plain object.
 *
 * Usage: response validation.
 *
 * @param candidate - Value to check.
 * @returns True for non-null, non-array objects.
 */
function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

/**
 * Keep only string → string entries of an object.
 *
 * Usage: sanitise ``plateFiles``.
 *
 * @param candidate - Value from the response.
 * @returns A new object with the valid entries.
 */
function stringMap(candidate: unknown): Record<string, string> {
  const validEntries: Record<string, string> = {};
  if (!isRecord(candidate)) return validEntries;
  for (const [entryKey, entryValue] of Object.entries(candidate)) {
    if (typeof entryValue === "string") validEntries[entryKey] = entryValue;
  }
  return validEntries;
}

/**
 * Load the rotation model.
 *
 * Usage: once at start-up.
 *
 * @returns The model.
 * @throws Error when the request fails or the body is not a rotation model.
 */
export async function fetchRotationModel(): Promise<RotationModel> {
  const responseBody = await fetchJson("/rotations");
  if (!isRecord(responseBody) || typeof responseBody.maxAge !== "number" || !isRecord(responseBody.plates)) {
    throw new Error("invalid rotation model");
  }
  return responseBody as unknown as RotationModel;
}

/**
 * Load the plate-layer build status.
 *
 * Usage: polled while the server builds the layers.
 *
 * @returns Validated status (unknown statuses become "failed").
 * @throws Error when the request fails.
 */
export async function fetchPlateStatus(): Promise<PlateStatusResponse> {
  const responseBody = await fetchJson("/plates/status");
  if (!isRecord(responseBody)) throw new Error("invalid plate status");
  const rawStatus = responseBody.status;
  return {
    status: PLATE_STATUSES.includes(rawStatus as PlateBuildStatus) ? (rawStatus as PlateBuildStatus) : "failed",
    detail: typeof responseBody.detail === "string" ? responseBody.detail : "",
    plateFiles: stringMap(responseBody.plateFiles),
    staticFile: typeof responseBody.staticFile === "string" ? responseBody.staticFile : null,
  };
}

/**
 * Load and parse the static-polygon layer.
 *
 * Usage: first point selection.
 *
 * @param staticFile - File name reported by /api/plates/status.
 * @returns Static polygons.
 * @throws Error when the request fails or the body is not a FeatureCollection.
 */
export async function fetchStaticPolygons(staticFile: string): Promise<StaticPolygon[]> {
  const queryParams = new URLSearchParams({ file: staticFile, bbox: "-180,-90,180,90", limit: "100000", min_area: "0" });
  const responseBody = await fetchJson(`/land?${queryParams}`);
  if (!isRecord(responseBody) || !Array.isArray(responseBody.features)) throw new Error("invalid static polygons");
  return parseStaticPolygons(responseBody as unknown as StaticFeatureCollection);
}
