/** Data types shared by the land mesher, its worker and the renderer. */

import type { LonLatPoint } from "../geodesy/wgs84Ellipsoid";
import type { BoundingBox } from "./boundingBox";
import type { PoleKind } from "./poleDetection";

// GeoJSON member names (type, coordinates, geometry, properties, features) are fixed by RFC 7946.
export type GeoJsonGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] }
  | { type: string; coordinates: unknown };

export type GeoJsonFeature = {
  type: "Feature";
  id?: number | string;
  geometry: GeoJsonGeometry | null;
  properties?: Record<string, unknown>;
};

/** FeatureCollection as served by /api/land (``count`` is an API extension). */
export type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
  count?: number;
};

export type MeshStats = {
  featuresIn: number;
  polygonsIn: number;
  polygonsOut: number;
  earcutEmpty: number;
  earcutThrow: number;
  datelineSplits: number;
  poleHandled: number;
  skippedDegenerate: number;
  zeroChartArea: number;
  vertices: number;
  triangles: number;
  maxEdgeMObserved: number;
  failureReasons: string[];
};

/** Features sharing a plate and lifetime; vertices reference one by index. */
export type PlateGroup = { plateNumber: number; appearAgeMa: number; vanishAgeMa: number };

export type LandMesh = {
  positions: Float32Array;
  vertexNormals: Float32Array;
  triangleIndices: Uint32Array;
  /** Per vertex: index into `plateGroups` (plate + lifetime of its feature). */
  groupIdx: Uint16Array;
  plateGroups: PlateGroup[];
  featureCount: number;
  triangleCount: number;
  meshStats: MeshStats;
};

/** A simple polygon ready for charting: exterior, holes and the pole it encloses. */
export type PolygonPiece = { exteriorRing: LonLatPoint[]; holeRings: LonLatPoint[][]; poleKind: PoleKind };

/** Triangulated piece: vertex lon/lats and triangle vertex indices into them. */
export type TriangulatedPiece = { vertexLonLats: LonLatPoint[]; triangleList: number[] };

export type MeshProgressFn = (doneCount: number, totalCount: number) => void;

export type MeshBuildOptions = {
  /** Clip features to this box (detail views); omitted or world-sized = no clipping. */
  clipBounds?: BoundingBox;
  /** Camera height; selects the tessellation LOD instead of the file's LOD. */
  cameraHeightM?: number;
};

/** Present-day land without plate tags: never moves, always exists. */
export const UNTAGGED_GROUP: PlateGroup = { plateNumber: 0, appearAgeMa: 1e6, vanishAgeMa: 0 };

const MAX_RECORDED_REASONS = 32;

/**
 * Create zeroed mesh statistics.
 *
 * Usage: start of every mesh build.
 *
 * @returns Fresh MeshStats.
 */
export function emptyStats(): MeshStats {
  return {
    featuresIn: 0,
    polygonsIn: 0,
    polygonsOut: 0,
    earcutEmpty: 0,
    earcutThrow: 0,
    datelineSplits: 0,
    poleHandled: 0,
    skippedDegenerate: 0,
    zeroChartArea: 0,
    vertices: 0,
    triangles: 0,
    maxEdgeMObserved: 0,
    failureReasons: [],
  };
}

/**
 * Record a failure reason (bounded list for diagnostics).
 *
 * Usage: whenever a polygon piece is skipped.
 *
 * @param meshStats - Statistics to update.
 * @param reasonCode - Short reason code, e.g. "degenerate_ring".
 * @returns Nothing.
 */
export function noteReason(meshStats: MeshStats, reasonCode: string): void {
  if (meshStats.failureReasons.length < MAX_RECORDED_REASONS) meshStats.failureReasons.push(reasonCode);
}

/**
 * Count a skipped degenerate ring.
 *
 * Usage: shared by every step that rejects rings with fewer than 3 vertices.
 *
 * @param meshStats - Statistics to update.
 * @returns Nothing.
 */
export function noteDegenerate(meshStats: MeshStats): void {
  meshStats.skippedDegenerate++;
  noteReason(meshStats, "degenerate_ring");
}
