/** Per-resolution cache of plate rotations at several ages (half-stage rotations need more than one age). */

import type { Quaternion } from "../quaternionMath";
import type { RotationTree } from "../rotationTree";

/** Read-only rotation lookup used by the topology code. */
export interface RotationLookup {
  rotationAt(plateNumber: number, ageInMyr: number): Quaternion | null;
}

export class RotationCache implements RotationLookup {
  private readonly cachedRotations = new Map<string, Quaternion | null>();

  /**
   * Wrap a rotation tree.
   *
   * Usage: one cache per resolution (ages and plates repeat a lot within one).
   *
   * @param rotationTree - Rotation model.
   */
  constructor(private readonly rotationTree: RotationTree) {}

  /**
   * Total rotation of a plate at an age.
   *
   * Usage: every plate rotation the topology code needs.
   *
   * @param plateNumber - Plate id (0 = anchor).
   * @param ageInMyr - Age in Ma.
   * @returns The rotation, or null where the plate has no poles.
   */
  rotationAt(plateNumber: number, ageInMyr: number): Quaternion | null {
    const cacheKey = `${plateNumber}@${ageInMyr}`;
    let plateRotation = this.cachedRotations.get(cacheKey);
    if (plateRotation === undefined) {
      plateRotation = this.rotationTree.totalRotation(plateNumber, ageInMyr);
      this.cachedRotations.set(cacheKey, plateRotation);
    }
    return plateRotation;
  }
}
