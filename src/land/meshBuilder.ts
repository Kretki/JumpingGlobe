/** Build one ECEF triangle mesh from an EPSG:4326 GeoJSON FeatureCollection of land polygons. */

import { normalizeLonLat } from "../geodesy/angleMath";
import { lonLatNormal, lonLatToEcef, WGS84_SEMI_MAJOR, type LonLatPoint } from "../geodesy/wgs84Ellipsoid";
import { isWorldBounds, padBounds, type BoundingBox } from "./boundingBox";
import { ensureOutward, splitLongEdges } from "./edgeRefinement";
import { LAND_HEIGHT_M } from "./geodesicDensify";
import { maxBoundaryEdgeMFromOrderNum, maxEdgeMFromOrderNum, meshLodFromHeight } from "./lod.config";
import {
  emptyStats,
  noteReason,
  UNTAGGED_GROUP,
  type GeoJsonFeature,
  type GeoJsonFeatureCollection,
  type LandMesh,
  type MeshBuildOptions,
  type MeshProgressFn,
  type MeshStats,
  type PlateGroup,
  type PolygonPiece,
} from "./meshTypes";
import { triangulatePiece } from "./pieceTriangulation";
import { preparePolygonPieces } from "./polygonPieces";
import { clipPreparedPiece } from "./rectClipping";

// Detail meshes overlap the base mesh's discard box by this much so no seam
// pixels show at the boundary; the data itself only covers the requested bbox.
const CLIP_PAD_DEG = 0.01;
const UNDERCUT_TOLERANCE = 1.05;

/** Growable vertex/index buffers of the mesh under construction. */
type MeshBuffers = { positionData: number[]; normalData: number[]; indexData: number[] };

/**
 * Plate group (plate id + lifetime) of a feature from its properties.
 *
 * Usage: tag vertices for plate reconstruction.
 *
 * @param landFeature - GeoJSON feature; ``plate_id``/``from_age``/``to_age`` are API property names.
 * @returns Its PlateGroup, or UNTAGGED_GROUP for untagged features.
 */
function featureGroup(landFeature: GeoJsonFeature): PlateGroup {
  const featureProps = landFeature.properties;
  if (!featureProps || typeof featureProps.plate_id !== "number") return UNTAGGED_GROUP;
  return {
    plateNumber: featureProps.plate_id,
    appearAgeMa: typeof featureProps.from_age === "number" ? featureProps.from_age : 1e6,
    vanishAgeMa: typeof featureProps.to_age === "number" ? featureProps.to_age : 0,
  };
}

/**
 * Height that keeps flat triangles above the ellipsoid.
 *
 * Usage: flat triangles with edges ≤ edgeMeters sag below the ellipsoid by at most
 * ~L²/(6R); lifting coarse LODs by that sag keeps them out of the ocean, which lets
 * world-scale LODs use much larger triangles.
 *
 * @param edgeMeters - Largest edge of the LOD.
 * @returns Land height in metres.
 */
function landHeightForEdge(edgeMeters: number): number {
  return LAND_HEIGHT_M + (edgeMeters * edgeMeters) / (6 * WGS84_SEMI_MAJOR);
}

/**
 * Triangulate, refine and append one polygon piece to the mesh buffers.
 *
 * Usage: per prepared (and possibly clippedPolygon) piece.
 *
 * @param polygonPiece - Piece to mesh.
 * @param lodLevel - Tessellation LOD (selects edge budgets).
 * @param meshBuffers - Output buffers; appended in place.
 * @param meshStats - Statistics to update.
 * @returns Number of triangles appended.
 */
function appendPiece(polygonPiece: PolygonPiece, lodLevel: number, meshBuffers: MeshBuffers, meshStats: MeshStats): number {
  const boundaryMax = maxBoundaryEdgeMFromOrderNum(lodLevel);
  const edgeBudgetMax = maxEdgeMFromOrderNum(lodLevel);
  const landHeight = landHeightForEdge(Math.max(edgeBudgetMax, boundaryMax));
  const triangulated = triangulatePiece(
    polygonPiece.exteriorRing,
    polygonPiece.holeRings,
    polygonPiece.poleKind,
    boundaryMax,
    meshStats
  );
  if (!triangulated) return 0;

  const localPositions: number[] = [];
  const localIndices: number[] = [];
  for (const [longitudeDeg, latitudeDeg] of triangulated.vertexLonLats) {
    const normalized: LonLatPoint = normalizeLonLat([longitudeDeg, latitudeDeg]);
    const [ecefPointX, ecefPointY, ecefPointZ] = lonLatToEcef(normalized[0], normalized[1], landHeight);
    localPositions.push(ecefPointX, ecefPointY, ecefPointZ);
  }
  const triangleList = triangulated.triangleList;
  for (let triangleStart = 0; triangleStart < triangleList.length; triangleStart += 3) {
    const [orderedA, orderedB, orderedC] = ensureOutward(
      localPositions,
      triangleList[triangleStart],
      triangleList[triangleStart + 1],
      triangleList[triangleStart + 2]
    );
    localIndices.push(orderedA, orderedB, orderedC);
  }

  const { maxEdgeLength } = splitLongEdges(localPositions, localIndices, edgeBudgetMax, landHeight);
  meshStats.maxEdgeMObserved = Math.max(meshStats.maxEdgeMObserved, maxEdgeLength);
  if (maxEdgeLength > edgeBudgetMax * UNDERCUT_TOLERANCE) noteReason(meshStats, "undercut");

  // Normals for all vertices (including split midpoints, via ECEF → lon/lat).
  const baseVertex = meshBuffers.positionData.length / 3;
  const vertexCount = localPositions.length / 3;
  for (let vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) {
    const ecefPointX = localPositions[vertexIdx * 3];
    const ecefPointY = localPositions[vertexIdx * 3 + 1];
    const ecefPointZ = localPositions[vertexIdx * 3 + 2];
    meshBuffers.positionData.push(ecefPointX, ecefPointY, ecefPointZ);
    const longitudeDeg = (Math.atan2(ecefPointY, ecefPointX) * 180) / Math.PI;
    const planarDist = Math.hypot(ecefPointX, ecefPointY);
    const latitudeDeg = (Math.atan2(ecefPointZ, planarDist) * 180) / Math.PI;
    const [normalVecX, normalVecY, normalVecZ] = lonLatNormal(longitudeDeg, latitudeDeg);
    meshBuffers.normalData.push(normalVecX, normalVecY, normalVecZ);
  }
  let triangleCount = 0;
  for (let listIndex = 0; listIndex < localIndices.length; listIndex += 3) {
    meshBuffers.indexData.push(
      baseVertex + localIndices[listIndex],
      baseVertex + localIndices[listIndex + 1],
      baseVertex + localIndices[listIndex + 2]
    );
    triangleCount++;
  }
  meshStats.polygonsOut++;
  return triangleCount;
}

/**
 * Mesh one polygon's rings, optionally clippedPolygon to a box.
 *
 * Usage: per Polygon and per MultiPolygon member.
 *
 * @param polygonRings - GeoJSON rings (exterior first).
 * @param lodLevel - Tessellation LOD.
 * @param meshBuffers - Output buffers.
 * @param meshStats - Statistics to update.
 * @param clipBounds - Optional clip box (world-sized boxes are ignored).
 * @returns Number of triangles appended.
 */
function processPolygonRings(
  polygonRings: number[][][],
  lodLevel: number,
  meshBuffers: MeshBuffers,
  meshStats: MeshStats,
  clipBounds?: BoundingBox
): number {
  meshStats.polygonsIn++;
  let polygonPieces = preparePolygonPieces(polygonRings, meshStats);
  if (clipBounds && !isWorldBounds(clipBounds)) {
    const paddedBounds = padBounds(clipBounds, CLIP_PAD_DEG);
    const clippedPieces: PolygonPiece[] = [];
    for (const polygonPiece of polygonPieces) clippedPieces.push(...clipPreparedPiece(polygonPiece, paddedBounds));
    polygonPieces = clippedPieces;
  }
  let triangleCount = 0;
  for (const polygonPiece of polygonPieces) triangleCount += appendPiece(polygonPiece, lodLevel, meshBuffers, meshStats);
  return triangleCount;
}

/**
 * Clip box of a feature: its own ``clip`` property (past-age detail) or the shared box.
 *
 * Usage: past-time detail features each lie in a different present-day box.
 *
 * @param landFeature - GeoJSON feature.
 * @param sharedBounds - Box applied to features without their own clip.
 * @returns The box to clip with, or undefined.
 */
function featureClipBounds(landFeature: GeoJsonFeature, sharedBounds?: BoundingBox): BoundingBox | undefined {
  const clipValue = landFeature.properties?.clip;
  if (Array.isArray(clipValue) && clipValue.length === 4) {
    return { westEdge: clipValue[0], southEdge: clipValue[1], eastEdge: clipValue[2], northEdge: clipValue[3] };
  }
  return sharedBounds;
}

/** Assigns plate-group indices to vertices, deduplicating equal groups. */
class PlateGroupTable {
  readonly plateGroups: PlateGroup[] = [];
  readonly groupIdx: number[] = [];
  private readonly groupByKey = new Map<string, number>();

  /**
   * Tag a range of new vertices with a feature's plate group.
   *
   * Usage: after each feature is meshed.
   *
   * @param landFeature - Feature the vertices belong to.
   * @param vertexCount - Number of vertices appended for it.
   * @returns Nothing.
   */
  tagVertices(landFeature: GeoJsonFeature, vertexCount: number): void {
    const plateGroup = featureGroup(landFeature);
    const groupKey = `${plateGroup.plateNumber}|${plateGroup.appearAgeMa}|${plateGroup.vanishAgeMa}`;
    let groupIndex = this.groupByKey.get(groupKey);
    if (groupIndex === undefined) {
      groupIndex = this.plateGroups.length;
      this.plateGroups.push(plateGroup);
      this.groupByKey.set(groupKey, groupIndex);
    }
    for (let vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) this.groupIdx.push(groupIndex);
  }
}

/**
 * Mesh one feature's geometry.
 *
 * Usage: per feature in featureCollectionToMesh.
 *
 * @param landFeature - Feature with a Polygon or MultiPolygon geometry (others are ignored).
 * @param lodLevel - Tessellation LOD.
 * @param meshBuffers - Output buffers.
 * @param meshStats - Statistics to update.
 * @param clipBounds - Clip box, if any.
 * @param reportProgress - Called with a fraction of this feature done.
 * @returns Number of triangles appended.
 */
function meshFeature(
  landFeature: GeoJsonFeature,
  lodLevel: number,
  meshBuffers: MeshBuffers,
  meshStats: MeshStats,
  clipBounds: BoundingBox | undefined,
  reportProgress: (featureFraction: number) => void
): number {
  const geometry = landFeature.geometry!;
  if (geometry.type === "Polygon") {
    reportProgress(0.25);
    return processPolygonRings(geometry.coordinates as number[][][], lodLevel, meshBuffers, meshStats, clipBounds);
  }
  if (geometry.type !== "MultiPolygon") return 0;
  const memberPolygons = geometry.coordinates as number[][][][];
  const memberCount = Math.max(1, memberPolygons.length);
  let triangleCount = 0;
  for (let memberIdx = 0; memberIdx < memberPolygons.length; memberIdx++) {
    reportProgress(memberIdx / memberCount);
    triangleCount += processPolygonRings(memberPolygons[memberIdx], lodLevel, meshBuffers, meshStats, clipBounds);
  }
  return triangleCount;
}

/**
 * Convert a FeatureCollection (EPSG:4326) into a single ECEF mesh.
 *
 * Usage: in the mesh worker (or on the main thread as a fallback) for every land load.
 *
 * @param featureCollection - Land features from /api/land or /api/land/past.
 * @param lodLevel - LOD of the source file (used when no camera height is given).
 * @param onProgress - Optional progress callback (features done, total).
 * @param buildOptions - Optional clip box and camera height.
 * @returns The mesh with per-vertex plate groups and statistics.
 */
export function featureCollectionToMesh(
  featureCollection: GeoJsonFeatureCollection,
  lodLevel = 0,
  onProgress?: MeshProgressFn,
  buildOptions?: MeshBuildOptions
): LandMesh {
  const tessellationLod = buildOptions?.cameraHeightM != null ? meshLodFromHeight(buildOptions.cameraHeightM) : lodLevel;
  const meshBuffers: MeshBuffers = { positionData: [], normalData: [], indexData: [] };
  const meshStats = emptyStats();
  meshStats.featuresIn = featureCollection.features.length;
  const groupTable = new PlateGroupTable();
  let featureCount = 0;
  let triangleCount = 0;
  const totalFeatures = Math.max(1, featureCollection.features.length);
  let processedCount = 0;
  let lastEmitted = -1;

  const reportProgress = (featureFraction = 0) => {
    if (!onProgress) return;
    const progressValue = Math.min(totalFeatures, processedCount + featureFraction);
    if (progressValue === lastEmitted && processedCount < totalFeatures) return;
    lastEmitted = progressValue;
    onProgress(progressValue, totalFeatures);
  };
  reportProgress();

  for (const landFeature of featureCollection.features) {
    const verticesBefore = meshBuffers.positionData.length / 3;
    if (landFeature.geometry) {
      const clipBounds = featureClipBounds(landFeature, buildOptions?.clipBounds);
      const featureTriangles = meshFeature(landFeature, tessellationLod, meshBuffers, meshStats, clipBounds, reportProgress);
      if (featureTriangles > 0) {
        featureCount++;
        triangleCount += featureTriangles;
      }
      const verticesAfter = meshBuffers.positionData.length / 3;
      if (verticesAfter > verticesBefore) groupTable.tagVertices(landFeature, verticesAfter - verticesBefore);
    }
    processedCount++;
    reportProgress();
  }

  meshStats.vertices = meshBuffers.positionData.length / 3;
  meshStats.triangles = triangleCount;
  logMeshSummary(tessellationLod, featureCount, triangleCount, meshStats);

  return {
    positions: new Float32Array(meshBuffers.positionData),
    vertexNormals: new Float32Array(meshBuffers.normalData),
    triangleIndices: new Uint32Array(meshBuffers.indexData),
    groupIdx: new Uint16Array(groupTable.groupIdx),
    plateGroups: groupTable.plateGroups,
    featureCount,
    triangleCount,
    meshStats,
  };
}

/**
 * Log a one-line mesh summary for diagnostics.
 *
 * Usage: end of featureCollectionToMesh.
 *
 * @param tessellationLod - LOD used.
 * @param featureCount - Features that produced triangles.
 * @param triangleCount - Triangles produced.
 * @param meshStats - Statistics.
 * @returns Nothing.
 */
function logMeshSummary(tessellationLod: number, featureCount: number, triangleCount: number, meshStats: MeshStats): void {
  if (typeof console === "undefined" || !console.info) return;
  console.info("[land mesh]", {
    lodLevel: tessellationLod,
    featureCount,
    triangleCount,
    vertexCount: meshStats.vertices,
    earcutEmpty: meshStats.earcutEmpty,
    earcutThrow: meshStats.earcutThrow,
    datelineSplits: meshStats.datelineSplits,
    poleHandled: meshStats.poleHandled,
    maxEdgeMObserved: Math.round(meshStats.maxEdgeMObserved),
    failureReasons: meshStats.failureReasons.slice(0, 8),
  });
}
