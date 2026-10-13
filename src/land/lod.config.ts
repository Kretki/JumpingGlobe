/** LOD selection from lod.json (shared with the Python server): files, edge budgets and request limits per camera height. */

import lodSettings from "../../lod.json";
import type { BoundingBox } from "./boundingBox";

/** LOD level (``orderNum`` in lod.json). */
export type LodLevel = number;

// lod.json member names (worldFile, bands, orderNum, fromHeightM, ...) are the config file format.
type LodBand = (typeof lodSettings.bands)[number];
type HeightRow = (typeof lodSettings.fromHeightM)[number];

export const WORLD_FILE = lodSettings.worldFile;

export const WORLD_BOUNDS: BoundingBox = { westEdge: -180, southEdge: -85, eastEdge: 180, northEdge: 85 };

const DEFAULT_BAND: LodBand = { file: WORLD_FILE, orderNum: 0, maxEdgeM: 25000, maxBoundaryEdgeM: 25000 };
const DEFAULT_HEIGHT_ROW: HeightRow = { orderNum: 0, height: 0, minAreaDeg2: 0, featureLimit: 4000 };

const sortedBands = [...lodSettings.bands].sort((firstBand, secondBand) => firstBand.orderNum - secondBand.orderNum);
const fileByOrderNum = new Map<number, string>(lodSettings.bands.map((bandEntry) => [bandEntry.orderNum, bandEntry.file]));

/**
 * Band of a LOD level, falling back to the nearest configured band.
 *
 * Usage: edge budgets of a tessellation LOD.
 *
 * @param orderNumber - LOD level.
 * @returns The band entry.
 */
function bandByOrderNum(orderNumber: number): LodBand {
  const exactBand = lodSettings.bands.find((bandEntry) => bandEntry.orderNum === orderNumber);
  if (exactBand) return exactBand;
  if (sortedBands.length === 0) return DEFAULT_BAND;
  if (orderNumber <= sortedBands[0].orderNum) return sortedBands[0];
  return sortedBands[sortedBands.length - 1];
}

/**
 * The fromHeightM row that applies at a camera height.
 *
 * Usage: every height-based lookup below.
 *
 * @param heightMeters - Camera height above the surface.
 * @returns First row (by descending height) the camera is above; the lowest row otherwise.
 */
function heightRowAt(heightMeters: number): HeightRow {
  const heightRows = [...lodSettings.fromHeightM].sort((firstRow, secondRow) => secondRow.height - firstRow.height);
  if (heightRows.length === 0) return DEFAULT_HEIGHT_ROW;

  const matchIndex = heightRows.findIndex((heightRow) => heightMeters > heightRow.height);
  if (matchIndex === -1) return heightRows[heightRows.length - 1];

  return heightRows[Math.max(matchIndex - 1, 0)];
}

/**
 * GeoPackage file to load at a camera height.
 *
 * Usage: choose the detail layer for the current view.
 *
 * @param heightMeters - Camera height.
 * @returns LOD file name (the world file when unmapped).
 */
export function lodFileFromHeight(heightMeters: number): string {
  return fileByOrderNum.get(heightRowAt(heightMeters).orderNum) ?? WORLD_FILE;
}

/**
 * LOD level of a file name.
 *
 * Usage: tessellation LOD of loaded data.
 *
 * @param fileName - GeoPackage file name.
 * @returns The configured level, a ``lodN`` number in the name, or the first band's level.
 */
export function meshLodFromFile(fileName: string): LodLevel {
  const namedBand = lodSettings.bands.find((bandEntry) => bandEntry.file === fileName);
  if (namedBand && Number.isFinite(namedBand.orderNum)) return namedBand.orderNum;
  const lodMatch = /lod(\d+)/i.exec(fileName);
  if (lodMatch) {
    const levelNumber = Number(lodMatch[1]);
    if (Number.isFinite(levelNumber)) return levelNumber;
  }
  return sortedBands[0]?.orderNum ?? 0;
}

/**
 * Tessellation LOD at a camera height.
 *
 * Usage: detail meshes are tessellated for the view, not for the file.
 *
 * @param heightMeters - Camera height.
 * @returns LOD level.
 */
export function meshLodFromHeight(heightMeters: number): LodLevel {
  return heightRowAt(heightMeters).orderNum;
}

/**
 * Minimum polygon envelope area requested at a camera height.
 *
 * Usage: ``min_area`` query parameter.
 *
 * @param heightMeters - Camera height.
 * @returns Area in deg².
 */
export function minAreaFromHeight(heightMeters: number): number {
  return heightRowAt(heightMeters).minAreaDeg2;
}

/**
 * Maximum feature count requested at a camera height.
 *
 * Usage: ``limit`` query parameter.
 *
 * @param heightMeters - Camera height.
 * @returns Feature limit.
 */
export function featureLimitFromHeight(heightMeters: number): number {
  return heightRowAt(heightMeters).featureLimit;
}

/**
 * Interior edge budget of a LOD.
 *
 * Usage: mesh refinement.
 *
 * @param orderNumber - LOD level.
 * @returns Maximum edge length in metres.
 */
export function maxEdgeMFromOrderNum(orderNumber: number): number {
  return bandByOrderNum(orderNumber).maxEdgeM;
}

/**
 * Boundary edge budget of a LOD.
 *
 * Usage: ring densification before triangulation.
 *
 * @param orderNumber - LOD level.
 * @returns Maximum boundary edge length in metres.
 */
export function maxBoundaryEdgeMFromOrderNum(orderNumber: number): number {
  return bandByOrderNum(orderNumber).maxBoundaryEdgeM;
}
