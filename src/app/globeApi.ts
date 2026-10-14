/** Typed, validated access to the non-land API endpoints. */

import type { RotationModel } from "../plates/rotationTree";
import { parsePlateOutlines, type PlateOutline } from "../plates/plateOutlines";
import { parseStaticPolygons, type StaticFeatureCollection, type StaticPolygon } from "../plates/staticPolygons";
import { parseTopologyModel, type TopologyModel } from "../plates/topology/topologyModel";

const API_PREFIX = "/api";
const PLATE_STATUSES = ["ready", "building", "failed", "unavailable"] as const;

export type PlateBuildStatus = (typeof PLATE_STATUSES)[number];

/** Body of /api/plates/status (member names are the API's). */
export type PlateStatusResponse = {
  status: PlateBuildStatus;
  detail: string;
  plateFiles: Record<string, string>;
  staticFile: string | null;
  outlinesFile: string | null;
  /** Build state of the plate-topology model (same values as ``status``). */
  topologyStatus: PlateBuildStatus;
  topologyDetail: string;
  topologyFile: string | null;
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
 * Validate a build status value.
 *
 * Usage: plate-layer and topology statuses.
 *
 * @param rawStatus - Value from the response.
 * @returns The status; unknown values become "failed".
 */
function buildStatusOf(rawStatus: unknown): PlateBuildStatus {
  return PLATE_STATUSES.includes(rawStatus as PlateBuildStatus) ? (rawStatus as PlateBuildStatus) : "failed";
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
  return {
    status: buildStatusOf(responseBody.status),
    detail: typeof responseBody.detail === "string" ? responseBody.detail : "",
    plateFiles: stringMap(responseBody.plateFiles),
    staticFile: typeof responseBody.staticFile === "string" ? responseBody.staticFile : null,
    outlinesFile: typeof responseBody.outlinesFile === "string" ? responseBody.outlinesFile : null,
    topologyStatus: buildStatusOf(responseBody.topologyStatus),
    topologyDetail: typeof responseBody.topologyDetail === "string" ? responseBody.topologyDetail : "",
    topologyFile: typeof responseBody.topologyFile === "string" ? responseBody.topologyFile : null,
  };
}

/**
 * GET a whole-world GeoJSON layer from /api/land.
 *
 * Usage: static polygons and plate outlines (small files loaded once).
 *
 * @param layerFile - File name reported by /api/plates/status.
 * @returns The FeatureCollection.
 * @throws Error when the request fails or the body is not a FeatureCollection.
 */
async function fetchWorldLayer(layerFile: string): Promise<StaticFeatureCollection> {
  const queryParams = new URLSearchParams({ file: layerFile, bbox: "-180,-90,180,90", limit: "100000", min_area: "0" });
  const responseBody = await fetchJson(`/land?${queryParams}`);
  if (!isRecord(responseBody) || !Array.isArray(responseBody.features)) throw new Error(`invalid layer ${layerFile}`);
  return responseBody as unknown as StaticFeatureCollection;
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
  return parseStaticPolygons(await fetchWorldLayer(staticFile));
}

/**
 * Load and prepare the plate-outline layer.
 *
 * Usage: first time the user ticks "Plate outlines".
 *
 * @param outlinesFile - File name reported by /api/plates/status.
 * @returns Outlines ready for reconstruction.
 * @throws Error when the request fails or the body is not a FeatureCollection.
 */
export async function fetchPlateOutlines(outlinesFile: string): Promise<PlateOutline[]> {
  return parsePlateOutlines(await fetchWorldLayer(outlinesFile));
}

/**
 * Load and prepare the plate-topology model (plate polygons and boundary sections).
 *
 * Usage: first time a tectonic layer (boundaries, motion, subducting plates, events) is ticked.
 *
 * @returns The prepared model.
 * @throws Error when the request fails or the body is not a topology model.
 */
export async function fetchPlateTopologies(): Promise<TopologyModel> {
  return parseTopologyModel(await fetchJson("/plates/topologies"));
}
