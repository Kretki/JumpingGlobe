/**
 * Merge the boundary pieces that different plates cut from the same section feature.
 *
 * Two plates sharing a boundary clip its feature slightly differently, and one long
 * feature (a trench) may border several plates along its length. Every piece is a
 * param range along the feature; overlapping ranges are merged so each stretch of a
 * boundary is drawn once, keeping every plate seen on its left and right.
 */

import type { UnitVector } from "../sphericalCoords";
import { slicePolyline } from "./arcIntersection";
import type { SectionFeature } from "./topologyModel";

/** One plate's piece of a section feature, as a param range in the feature's own direction. */
export type BoundaryPiece = {
  featureIndex: number;
  startParam: number;
  endParam: number;
  plateNumber: number;
  /** The plate lies on the left of the feature direction. */
  plateOnLeft: boolean;
};

/** A drawable stretch of plate boundary. */
export type BoundarySegment = {
  featureIndex: number;
  sectionFeature: SectionFeature;
  /** Polyline in the feature's own direction. */
  lineUnits: UnitVector[];
  /** Plates on the left of the feature direction along this stretch. */
  leftPlates: number[];
  /** Plates on the right of the feature direction. */
  rightPlates: number[];
};

/** Feature geometry and attributes needed to cut merged stretches. */
export interface SectionSource {
  featureGeometry(featureIndex: number): UnitVector[] | null;
  sectionFeature(featureIndex: number): SectionFeature;
}

const MERGE_GAP_PARAM = 1e-6;

/**
 * Overlapping (or touching) groups of pieces, in order along the feature.
 *
 * Usage: per feature.
 *
 * @param featurePieces - Pieces of one feature.
 * @returns Groups whose param ranges overlap.
 */
function overlappingGroups(featurePieces: BoundaryPiece[]): BoundaryPiece[][] {
  const sortedPieces = [...featurePieces].sort((firstPiece, secondPiece) => firstPiece.startParam - secondPiece.startParam);
  const groupList: BoundaryPiece[][] = [];
  let groupEnd = -Infinity;
  for (const boundaryPiece of sortedPieces) {
    if (!groupList.length || boundaryPiece.startParam > groupEnd + MERGE_GAP_PARAM) groupList.push([]);
    groupList[groupList.length - 1].push(boundaryPiece);
    groupEnd = Math.max(groupEnd, boundaryPiece.endParam);
  }
  return groupList;
}

/**
 * Unique plates of a group on one side.
 *
 * Usage: side lists of a merged stretch.
 *
 * @param pieceGroup - Merged pieces.
 * @param sideOnLeft - Which side to collect.
 * @returns Plate ids in first-seen order.
 */
function sidePlates(pieceGroup: BoundaryPiece[], sideOnLeft: boolean): number[] {
  return [...new Set(pieceGroup.filter((boundaryPiece) => boundaryPiece.plateOnLeft === sideOnLeft).map((boundaryPiece) => boundaryPiece.plateNumber))];
}

/**
 * Drawable stretch of one group of pieces.
 *
 * Usage: per merged group.
 *
 * @param pieceGroup - Overlapping pieces of one feature.
 * @param featureGeometry - The feature's geometry at the resolved age.
 * @param sectionFeature - The feature.
 * @returns The merged stretch, or null when it is degenerate.
 */
function mergedSegment(pieceGroup: BoundaryPiece[], featureGeometry: UnitVector[], sectionFeature: SectionFeature): BoundarySegment | null {
  const startParam = Math.min(...pieceGroup.map((boundaryPiece) => boundaryPiece.startParam));
  const endParam = Math.max(...pieceGroup.map((boundaryPiece) => boundaryPiece.endParam));
  if (endParam - startParam < MERGE_GAP_PARAM) return null;
  return {
    featureIndex: pieceGroup[0].featureIndex,
    sectionFeature,
    lineUnits: slicePolyline(featureGeometry, startParam, endParam),
    leftPlates: sidePlates(pieceGroup, true),
    rightPlates: sidePlates(pieceGroup, false),
  };
}

/**
 * Merge all boundary pieces of a resolution into drawable stretches.
 *
 * Usage: end of a resolution pass.
 *
 * @param boundaryPieces - Pieces from every resolved plate.
 * @param sectionSource - Geometry and attributes of the features.
 * @returns One stretch per overlapping group of pieces of each feature.
 */
export function mergeBoundaryPieces(boundaryPieces: BoundaryPiece[], sectionSource: SectionSource): BoundarySegment[] {
  const piecesByFeature = new Map<number, BoundaryPiece[]>();
  for (const boundaryPiece of boundaryPieces) {
    const featurePieces = piecesByFeature.get(boundaryPiece.featureIndex) ?? [];
    featurePieces.push(boundaryPiece);
    piecesByFeature.set(boundaryPiece.featureIndex, featurePieces);
  }
  const segmentList: BoundarySegment[] = [];
  for (const [featureIndex, featurePieces] of piecesByFeature) {
    const featureGeometry = sectionSource.featureGeometry(featureIndex);
    if (!featureGeometry || featureGeometry.length < 2) continue;
    for (const pieceGroup of overlappingGroups(featurePieces)) {
      const boundarySegment = mergedSegment(pieceGroup, featureGeometry, sectionSource.sectionFeature(featureIndex));
      if (boundarySegment) segmentList.push(boundarySegment);
    }
  }
  return segmentList;
}
