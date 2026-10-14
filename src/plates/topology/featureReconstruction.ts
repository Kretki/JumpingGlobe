/** Reconstruct section features (lines and points) to an age: by plate id, or by half-stage rotation for ridges. */

import { IDENTITY_QUAT, quatRotate, type Quaternion } from "../quaternionMath";
import type { UnitVector } from "../sphericalCoords";
import { halfStageRotation, usesHalfStage } from "./halfStageRotation";
import type { RotationLookup } from "./rotationCache";
import type { SectionFeature } from "./topologyModel";

/**
 * Whether a feature exists at an age (inside its valid time).
 *
 * Usage: sections of inactive features are left out of topologies (as in GPlates).
 *
 * @param sectionFeature - Feature.
 * @param ageInMyr - Age in Ma.
 * @returns True when endAge ≤ age ≤ beginAge.
 */
export function isFeatureActive(sectionFeature: SectionFeature, ageInMyr: number): boolean {
  return ageInMyr <= sectionFeature.beginAgeMa && ageInMyr >= sectionFeature.endAgeMa;
}

/**
 * Total rotation of a feature at an age.
 *
 * Usage: before rotating its geometry.
 *
 * @param rotationLookup - Plate rotations.
 * @param sectionFeature - Feature.
 * @param ageInMyr - Age in Ma.
 * @returns The rotation (identity for plate 0), or null when its plates have no poles.
 *   Half-stage features fall back to their plate id if the half-stage rotation is undefined.
 */
export function featureRotation(rotationLookup: RotationLookup, sectionFeature: SectionFeature, ageInMyr: number): Quaternion | null {
  if (usesHalfStage(sectionFeature)) {
    const spreadingRotation = halfStageRotation(rotationLookup, sectionFeature, ageInMyr);
    if (spreadingRotation) return spreadingRotation;
  }
  if (sectionFeature.plateNumber === 0) return IDENTITY_QUAT;
  return rotationLookup.rotationAt(sectionFeature.plateNumber, ageInMyr);
}

/**
 * Rotate a list of unit vectors.
 *
 * Usage: reconstructed feature geometry.
 *
 * @param rotationQuat - Rotation.
 * @param presentUnits - Present-day geometry.
 * @returns New rotated unit vectors.
 */
export function rotateUnits(rotationQuat: Quaternion, presentUnits: UnitVector[]): UnitVector[] {
  return presentUnits.map((presentUnit) => {
    const rotatedUnit: UnitVector = [0, 0, 0];
    quatRotate(rotationQuat, presentUnit[0], presentUnit[1], presentUnit[2], rotatedUnit);
    return rotatedUnit;
  });
}

/**
 * Geometry of a line or point feature at an age.
 *
 * Usage: sections of topologies.
 *
 * @param rotationLookup - Plate rotations.
 * @param sectionFeature - Line or point feature.
 * @param ageInMyr - Age in Ma.
 * @returns Reconstructed unit vectors, or null when the feature is inactive, empty or has no rotation.
 */
export function reconstructFeature(rotationLookup: RotationLookup, sectionFeature: SectionFeature, ageInMyr: number): UnitVector[] | null {
  if (!isFeatureActive(sectionFeature, ageInMyr) || !sectionFeature.presentUnits.length) return null;
  const rotationQuat = featureRotation(rotationLookup, sectionFeature, ageInMyr);
  return rotationQuat ? rotateUnits(rotationQuat, sectionFeature.presentUnits) : null;
}
