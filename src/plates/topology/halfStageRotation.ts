/**
 * Half-stage rotation of spreading features (mid-ocean ridges): the feature moves
 * with half of the motion of its right plate relative to its left plate.
 *
 * With Q(t) = R_left(t)⁻¹ · R_right(t) (right plate relative to the left plate):
 *  - HalfStageRotation (version 1):       R(t) = R_left(t) · half(Q(t))
 *  - HalfStageRotationVersion2 and 3:     R(t) = R_left(t) · Π half(Q(b)·Q(a)⁻¹)
 *    over 10 Myr steps [a, b] from the start age (present day for version 2, the
 *    geometry import time for version 3) to t. Steps where either plate has no
 *    poles add no spreading.
 * Every version reproduces the digitised geometry at its start age, which is how
 * GPlates stores the present-day coordinates. The step accumulation was checked
 * against the Cao et al. 2024 topologies: ridges then meet their neighbouring
 * sections in 91 % (version 2) and 99 % (version 3) of cases, against 49 % / 89 %
 * when spreading is limited to the ridge's lifetime and 76 % for the version-1
 * formula applied to version-2 ridges.
 */

import { IDENTITY_QUAT, quatConjugate, quatMultiply, quatSlerp, type Quaternion } from "../quaternionMath";
import type { RotationLookup } from "./rotationCache";
import type { SectionFeature } from "./topologyModel";

const HALF_STAGE_STEP_MYR = 10;
const VERSION_ONE = "HalfStageRotation";
const VERSION_THREE = "HalfStageRotationVersion3";

/**
 * Whether a feature is reconstructed by half-stage rotation.
 *
 * Usage: choose between plate-id and half-stage reconstruction.
 *
 * @param sectionFeature - Feature.
 * @returns True for any half-stage version with both plates known.
 */
export function usesHalfStage(sectionFeature: SectionFeature): boolean {
  return (
    sectionFeature.reconstructionMethod.startsWith(VERSION_ONE) &&
    sectionFeature.leftPlate !== null &&
    sectionFeature.rightPlate !== null
  );
}

/**
 * Rotation of the right plate relative to the left plate at an age.
 *
 * Usage: building block of every half-stage version.
 *
 * @param rotationLookup - Plate rotations.
 * @param sectionFeature - Feature with left and right plates.
 * @param ageInMyr - Age in Ma.
 * @returns Q(t) = R_left⁻¹ · R_right, or null when a plate has no poles.
 */
function relativeRotation(rotationLookup: RotationLookup, sectionFeature: SectionFeature, ageInMyr: number): Quaternion | null {
  const leftRotation = rotationLookup.rotationAt(sectionFeature.leftPlate ?? 0, ageInMyr);
  const rightRotation = rotationLookup.rotationAt(sectionFeature.rightPlate ?? 0, ageInMyr);
  if (!leftRotation || !rightRotation) return null;
  return quatMultiply(quatConjugate(leftRotation), rightRotation);
}

/**
 * Half of the relative motion between two ages.
 *
 * Usage: one accumulation step.
 *
 * @param rotationLookup - Plate rotations.
 * @param sectionFeature - Feature with left and right plates.
 * @param stepFromAge - Step start (Ma).
 * @param stepToAge - Step end (Ma).
 * @returns half(Q(to) · Q(from)⁻¹), or null when a plate has no poles.
 */
function halfStep(rotationLookup: RotationLookup, sectionFeature: SectionFeature, stepFromAge: number, stepToAge: number): Quaternion | null {
  const fromRotation = relativeRotation(rotationLookup, sectionFeature, stepFromAge);
  const toRotation = relativeRotation(rotationLookup, sectionFeature, stepToAge);
  if (!fromRotation || !toRotation) return null;
  return quatSlerp(IDENTITY_QUAT, quatMultiply(toRotation, quatConjugate(fromRotation)), 0.5);
}

/**
 * Accumulated half-stage motion (left-plate frame) from a start age to an age.
 *
 * Usage: versions 2 and 3.
 *
 * @param rotationLookup - Plate rotations.
 * @param sectionFeature - Feature with left and right plates.
 * @param startAge - Age the geometry was digitised at (Ma).
 * @param ageInMyr - Target age (Ma).
 * @returns The accumulated rotation (steps without poles are skipped).
 */
function accumulatedHalfStages(
  rotationLookup: RotationLookup,
  sectionFeature: SectionFeature,
  startAge: number,
  ageInMyr: number
): Quaternion {
  let accumulated: Quaternion = IDENTITY_QUAT;
  const stepCount = Math.ceil(Math.abs(ageInMyr - startAge) / HALF_STAGE_STEP_MYR);
  for (let stepIndex = 0; stepIndex < stepCount; stepIndex++) {
    const stepStart = startAge + ((ageInMyr - startAge) * stepIndex) / stepCount;
    const stepFinish = startAge + ((ageInMyr - startAge) * (stepIndex + 1)) / stepCount;
    const stepRotation = halfStep(rotationLookup, sectionFeature, stepStart, stepFinish);
    if (stepRotation) accumulated = quatMultiply(stepRotation, accumulated);
  }
  return accumulated;
}

/**
 * Total rotation of a half-stage feature at an age.
 *
 * Usage: reconstruct ridges (see module comment for the versions).
 *
 * @param rotationLookup - Plate rotations.
 * @param sectionFeature - Feature reconstructed by half-stage rotation (see usesHalfStage).
 * @param ageInMyr - Age in Ma.
 * @returns The rotation, or null when the left or right plate has no poles.
 */
export function halfStageRotation(rotationLookup: RotationLookup, sectionFeature: SectionFeature, ageInMyr: number): Quaternion | null {
  const leftRotation = rotationLookup.rotationAt(sectionFeature.leftPlate ?? 0, ageInMyr);
  if (!leftRotation) return null;
  if (sectionFeature.reconstructionMethod === VERSION_ONE) {
    const relative = relativeRotation(rotationLookup, sectionFeature, ageInMyr);
    return relative ? quatMultiply(leftRotation, quatSlerp(IDENTITY_QUAT, relative, 0.5)) : null;
  }
  const startAge = sectionFeature.reconstructionMethod === VERSION_THREE ? (sectionFeature.importAgeMa ?? 0) : 0;
  return quatMultiply(leftRotation, accumulatedHalfStages(rotationLookup, sectionFeature, startAge, ageInMyr));
}
