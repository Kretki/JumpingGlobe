/**
 * The plate-topology model served by /api/plates/topologies (exported from the
 * plate model's GPML by tools/gpml_topologies.py), validated and prepared for
 * resolution: line and point geometries are converted to unit vectors once.
 */

import { lonLatToUnit, type UnitVector } from "../sphericalCoords";

/** A topology section: [feature index, 1 when traversed against the feature's direction]. */
export type SectionLink = [number, number];

/** Feature kinds of the model. */
export type FeatureKind = "line" | "point" | "topoline";

/** A geometry feature that topologies are built from (ridge, subduction zone, transform, ...). */
export type SectionFeature = {
  /** GPlates feature type, e.g. ``MidOceanRidge``, ``SubductionZone``, ``Transform``. */
  featureType: string;
  featureName: string;
  beginAgeMa: number;
  endAgeMa: number;
  plateNumber: number;
  /** ``ByPlateId``, ``HalfStageRotation``, ``HalfStageRotationVersion2`` or ``HalfStageRotationVersion3``. */
  reconstructionMethod: string;
  leftPlate: number | null;
  rightPlate: number | null;
  /** Age at which the geometry was digitised (half-stage version 3). */
  importAgeMa: number | null;
  /** Side of the overriding plate along the line (subduction zones). */
  polarity: "Left" | "Right" | null;
  featureKind: FeatureKind;
  /** Present-day geometry (line or point kinds). */
  presentUnits: UnitVector[];
  /** Sections of a topological line (topoline kind). */
  sectionLinks: SectionLink[];
};

/** Section list of a plate polygon during an age interval. */
export type TopologyWindow = { beginAgeMa: number; endAgeMa: number; sectionLinks: SectionLink[] };

/** A topological plate polygon (GPlates TopologicalClosedPlateBoundary). */
export type PlateTopology = {
  plateNumber: number;
  plateName: string;
  beginAgeMa: number;
  endAgeMa: number;
  windows: TopologyWindow[];
};

export type TopologyModel = { sectionFeatures: SectionFeature[]; plateTopologies: PlateTopology[] };

const DISTANT_PAST_MA = 1e6;
const FEATURE_KINDS: readonly FeatureKind[] = ["line", "point", "topoline"];

type RawRecord = Record<string, unknown>;

/**
 * Narrow an unknown value to a plain object.
 *
 * Usage: response validation.
 *
 * @param candidate - Value to check.
 * @returns True for non-null, non-array objects.
 */
function isRecord(candidate: unknown): candidate is RawRecord {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

/**
 * A finite number or a fallback.
 *
 * Usage: numeric members of the response.
 *
 * @param candidate - Value from the response.
 * @param fallbackValue - Returned when the value is not a finite number.
 * @returns The number.
 */
function numberOr(candidate: unknown, fallbackValue: number): number {
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallbackValue;
}

/**
 * A positive integer plate id, or null.
 *
 * Usage: left/right plates.
 *
 * @param candidate - Value from the response.
 * @returns The id, or null when missing or not positive.
 */
function plateOrNull(candidate: unknown): number | null {
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0 ? candidate : null;
}

/**
 * Valid section links (in range, well formed).
 *
 * Usage: topology windows and topological lines.
 *
 * @param candidate - ``sections`` member.
 * @param featureCount - Number of features in the model.
 * @returns The links; malformed or out-of-range entries are dropped.
 */
function parseLinks(candidate: unknown, featureCount: number): SectionLink[] {
  if (!Array.isArray(candidate)) return [];
  const linkList: SectionLink[] = [];
  for (const linkEntry of candidate) {
    if (!Array.isArray(linkEntry) || linkEntry.length !== 2) continue;
    const [featureIndex, reverseFlag] = linkEntry as unknown[];
    if (typeof featureIndex !== "number" || !Number.isInteger(featureIndex) || featureIndex < 0 || featureIndex >= featureCount) continue;
    linkList.push([featureIndex, reverseFlag === 1 ? 1 : 0]);
  }
  return linkList;
}

/**
 * Unit vectors of a flat [lon, lat, ...] list.
 *
 * Usage: line and point geometries.
 *
 * @param candidate - ``coords`` member.
 * @returns Unit vectors; non-numeric pairs are skipped.
 */
function parseCoordinates(candidate: unknown): UnitVector[] {
  if (!Array.isArray(candidate)) return [];
  const unitList: UnitVector[] = [];
  for (let valueIdx = 0; valueIdx + 1 < candidate.length; valueIdx += 2) {
    const longitudeDeg = candidate[valueIdx];
    const latitudeDeg = candidate[valueIdx + 1];
    if (typeof longitudeDeg === "number" && typeof latitudeDeg === "number") unitList.push(lonLatToUnit(longitudeDeg, latitudeDeg));
  }
  return unitList;
}

/**
 * Prepare one feature of the response.
 *
 * Usage: parseTopologyModel, per feature (indices must be kept, so invalid entries become empty features).
 *
 * @param rawFeature - Feature object from the response.
 * @param featureCount - Number of features (for link validation).
 * @returns The prepared feature.
 */
function parseFeature(rawFeature: unknown, featureCount: number): SectionFeature {
  const featureProps: RawRecord = isRecord(rawFeature) ? rawFeature : {};
  const featureKind = FEATURE_KINDS.find((kindName) => kindName === featureProps.kind) ?? "line";
  const polarity = featureProps.polarity === "Left" || featureProps.polarity === "Right" ? featureProps.polarity : null;
  return {
    featureType: typeof featureProps.type === "string" ? featureProps.type : "UnclassifiedFeature",
    featureName: typeof featureProps.name === "string" ? featureProps.name : "",
    beginAgeMa: numberOr(featureProps.begin, DISTANT_PAST_MA),
    endAgeMa: numberOr(featureProps.end, 0),
    plateNumber: numberOr(featureProps.plateId, 0),
    reconstructionMethod: typeof featureProps.method === "string" ? featureProps.method : "ByPlateId",
    leftPlate: plateOrNull(featureProps.left),
    rightPlate: plateOrNull(featureProps.right),
    importAgeMa: typeof featureProps.importAge === "number" && featureProps.importAge >= 0 ? featureProps.importAge : null,
    polarity,
    featureKind,
    presentUnits: featureKind === "topoline" ? [] : parseCoordinates(featureProps.coords),
    sectionLinks: featureKind === "topoline" ? parseLinks(featureProps.sections, featureCount) : [],
  };
}

/**
 * Prepare one topology of the response.
 *
 * Usage: parseTopologyModel, per topology.
 *
 * @param rawTopology - Topology object from the response.
 * @param featureCount - Number of features (for link validation).
 * @returns The topology, or null when it has no usable window.
 */
function parseTopology(rawTopology: unknown, featureCount: number): PlateTopology | null {
  if (!isRecord(rawTopology) || !Array.isArray(rawTopology.windows)) return null;
  const windowList: TopologyWindow[] = [];
  for (const rawWindow of rawTopology.windows) {
    if (!isRecord(rawWindow)) continue;
    const sectionLinks = parseLinks(rawWindow.sections, featureCount);
    if (sectionLinks.length) {
      windowList.push({ beginAgeMa: numberOr(rawWindow.begin, DISTANT_PAST_MA), endAgeMa: numberOr(rawWindow.end, 0), sectionLinks });
    }
  }
  if (!windowList.length) return null;
  return {
    plateNumber: numberOr(rawTopology.plateId, 0),
    plateName: typeof rawTopology.name === "string" ? rawTopology.name : "",
    beginAgeMa: numberOr(rawTopology.begin, DISTANT_PAST_MA),
    endAgeMa: numberOr(rawTopology.end, 0),
    windows: windowList,
  };
}

/**
 * Validate and prepare the /api/plates/topologies response.
 *
 * Usage: once, after fetching the model.
 *
 * @param responseBody - Parsed JSON body.
 * @returns The prepared model.
 * @throws Error when the body is not a topology model.
 */
export function parseTopologyModel(responseBody: unknown): TopologyModel {
  if (!isRecord(responseBody) || !Array.isArray(responseBody.features) || !Array.isArray(responseBody.topologies)) {
    throw new Error("invalid plate topology model");
  }
  const featureCount = responseBody.features.length;
  const sectionFeatures = responseBody.features.map((rawFeature) => parseFeature(rawFeature, featureCount));
  const plateTopologies: PlateTopology[] = [];
  for (const rawTopology of responseBody.topologies) {
    const plateTopology = parseTopology(rawTopology, featureCount);
    if (plateTopology) plateTopologies.push(plateTopology);
  }
  return { sectionFeatures, plateTopologies };
}
