/** Move plate outlines and their label anchors to their position at an age (CPU, per vertex). */

import { writeSurfacePoint } from "../geodesy/wgs84Ellipsoid";
import type { PlateOutline } from "./plateOutlines";
import { IDENTITY_QUAT, quatRotate, type Quaternion } from "./quaternionMath";
import type { RotationTree } from "./rotationTree";
import type { UnitVector } from "./sphericalCoords";

/** One plate name to show, at its reconstructed position. */
export type PlateLabel = { labelText: string; labelUnit: UnitVector };

/** Result of one reconstruction: how many line vertices were written and which labels to show. */
export type OutlineFrame = { vertexCount: number; plateLabels: PlateLabel[] };

/**
 * Number of floats needed to hold every outline at once.
 *
 * Usage: size the position buffer once after loading.
 *
 * @param outlineList - Prepared outlines.
 * @returns Total float count (xyz per vertex).
 */
export function outlineBufferLength(outlineList: PlateOutline[]): number {
  return outlineList.reduce((floatTotal, plateOutline) => floatTotal + plateOutline.segmentUnits.length, 0);
}

/**
 * Rotation of an outline at an age.
 *
 * Usage: per outline, before writing its vertices.
 *
 * @param plateOutline - Outline.
 * @param rotationTree - Rotation model.
 * @param ageInMyr - Age in Ma.
 * @returns The total rotation, or null when the plate does not exist then or has no poles.
 */
function outlineRotation(plateOutline: PlateOutline, rotationTree: RotationTree, ageInMyr: number): Quaternion | null {
  if (ageInMyr > plateOutline.appearAgeMa || ageInMyr < plateOutline.vanishAgeMa) return null;
  if (ageInMyr <= 0 || plateOutline.plateNumber === 0) return IDENTITY_QUAT;
  return rotationTree.totalRotation(plateOutline.plateNumber, ageInMyr);
}

/**
 * Rotate an outline's segments and write their ellipsoid positions.
 *
 * Usage: per visible outline.
 *
 * @param segmentUnits - Present-day unit vectors (xyz per vertex).
 * @param rotationQuat - Plate rotation at the age.
 * @param targetBuffer - ECEF position buffer.
 * @param floatOffset - First float to write.
 * @returns The float offset after the written vertices.
 */
function writeRotatedSegments(
  segmentUnits: Float32Array,
  rotationQuat: Quaternion,
  targetBuffer: Float32Array,
  floatOffset: number
): number {
  const rotatedUnit = [0, 0, 0];
  for (let valueIdx = 0; valueIdx < segmentUnits.length; valueIdx += 3) {
    quatRotate(rotationQuat, segmentUnits[valueIdx], segmentUnits[valueIdx + 1], segmentUnits[valueIdx + 2], rotatedUnit);
    writeSurfacePoint(rotatedUnit, targetBuffer, floatOffset + valueIdx);
  }
  return floatOffset + segmentUnits.length;
}

/**
 * Label of an outline at its reconstructed position.
 *
 * Usage: for the largest live outline of each plate.
 *
 * @param plateOutline - Outline.
 * @param rotationQuat - Plate rotation at the age.
 * @returns Label text and rotated anchor.
 */
function rotatedLabel(plateOutline: PlateOutline, rotationQuat: Quaternion): PlateLabel {
  const labelUnit: UnitVector = [0, 0, 0];
  const anchorUnit = plateOutline.labelUnit;
  quatRotate(rotationQuat, anchorUnit[0], anchorUnit[1], anchorUnit[2], labelUnit);
  return { labelText: plateOutline.plateName, labelUnit };
}

/**
 * Write the outlines visible at an age into a GL_LINES position buffer and collect one label per plate.
 *
 * Usage: whenever the age changes while outlines are shown. Outlines outside their
 * lifetime or without rotation poles at that age are left out (like the land).
 *
 * @param outlineList - Outlines sorted by size, largest first (see parsePlateOutlines).
 * @param rotationTree - Rotation model.
 * @param ageInMyr - Age in Ma.
 * @param targetBuffer - Buffer of outlineBufferLength(outlineList) floats; overwritten from the start.
 * @returns Vertex count written and labels, largest plate first.
 */
export function reconstructOutlines(
  outlineList: PlateOutline[],
  rotationTree: RotationTree,
  ageInMyr: number,
  targetBuffer: Float32Array
): OutlineFrame {
  let floatOffset = 0;
  const plateLabels: PlateLabel[] = [];
  const labelledPlates = new Set<number>();
  for (const plateOutline of outlineList) {
    const rotationQuat = outlineRotation(plateOutline, rotationTree, ageInMyr);
    if (!rotationQuat) continue;
    floatOffset = writeRotatedSegments(plateOutline.segmentUnits, rotationQuat, targetBuffer, floatOffset);
    // Sorted largest first, so the first live outline of a plate carries its label.
    if (labelledPlates.has(plateOutline.plateNumber)) continue;
    labelledPlates.add(plateOutline.plateNumber);
    plateLabels.push(rotatedLabel(plateOutline, rotationQuat));
  }
  return { vertexCount: floatOffset / 3, plateLabels };
}
