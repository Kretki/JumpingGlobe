/** Path of a selected point through time: its position at every sampled age. */

import { IDENTITY_QUAT, quatRotate } from "./quaternionMath";
import type { RotationTree } from "./rotationTree";
import type { UnitVector } from "./sphericalCoords";

/** Plate identity and lifetime needed to move a point. */
export type PlateLifetime = { plateNumber: number; appearAgeMa: number; vanishAgeMa: number };

/** Position at one sampled age; null where the plate has no rotation or did not exist. */
export type TrackSample = { ageInMyr: number; unitVector: UnitVector | null };

export type TrackedPoint = PlateLifetime & {
  plateName: string;
  /** Present-day unit vector (GPlates sphere: geodetic lon/lat as spherical). */
  presentUnit: UnitVector;
  presentLon: number;
  presentLat: number;
  trackSamples: TrackSample[];
};

/**
 * Position of a present-day point at an age.
 *
 * Usage: marker at the displayed age and every track sample.
 *
 * @param rotationTree - Rotation model.
 * @param plateLifetime - Plate and lifetime of the point.
 * @param presentUnit - Present-day unit vector.
 * @param ageInMyr - Age in Ma.
 * @returns Unit vector at that age, or null outside the lifetime or without rotation data.
 */
export function positionAt(
  rotationTree: RotationTree,
  plateLifetime: PlateLifetime,
  presentUnit: UnitVector,
  ageInMyr: number
): UnitVector | null {
  if (ageInMyr > plateLifetime.appearAgeMa || ageInMyr < plateLifetime.vanishAgeMa) return null;
  const plateQuat = ageInMyr <= 0 ? IDENTITY_QUAT : rotationTree.totalRotation(plateLifetime.plateNumber, ageInMyr);
  if (!plateQuat) return null;
  const rotatedUnit: UnitVector = [0, 0, 0];
  quatRotate(plateQuat, presentUnit[0], presentUnit[1], presentUnit[2], rotatedUnit);
  return rotatedUnit;
}

/**
 * Track a present-day point from 0 Ma back to a maximum age.
 *
 * Usage: selection track line.
 *
 * @param rotationTree - Rotation model.
 * @param plateLifetime - Plate and lifetime of the point.
 * @param presentUnit - Present-day unit vector.
 * @param maxAgeMa - Oldest age to sample.
 * @param stepSizeMyr - Sampling step in Myr.
 * @returns Samples at 0, step, 2·step, … ≤ maxAgeMa.
 */
export function computeTrack(
  rotationTree: RotationTree,
  plateLifetime: PlateLifetime,
  presentUnit: UnitVector,
  maxAgeMa: number,
  stepSizeMyr = 1
): TrackSample[] {
  const trackSamples: TrackSample[] = [];
  for (let ageInMyr = 0; ageInMyr <= maxAgeMa + 1e-9; ageInMyr += stepSizeMyr) {
    trackSamples.push({ ageInMyr, unitVector: positionAt(rotationTree, plateLifetime, presentUnit, ageInMyr) });
  }
  return trackSamples;
}
