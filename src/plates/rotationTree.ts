/**
 * GPlates-style plate reconstruction from a .rot model (lod.json plateModel; Cao et al. 2024).
 *
 * Each row of the rotation file is a *total* reconstruction pole: the finite
 * rotation of a moving plate relative to a fixed plate that takes present-day
 * geometry to its position at that age. Rows of one moving plate with the same
 * fixed plate form an interpolation sequence (quaternion slerp between poles);
 * the fixed plate may change between sequences (crossovers). Models split over
 * several files arrive concatenated per plate, so a new sequence also starts where
 * the age goes back (the next file). The rotation of a
 * plate relative to the anchor (000, spin axis) is the chain
 *   R(P→0, t) = R(F→0, t) · R(P→F, t).
 */

import { IDENTITY_QUAT, quatFromPole, quatMultiply, quatSlerp, type Quaternion } from "./quaternionMath";

/** [age Ma, pole lat°, pole lon°, angle°, fixed plate id] */
export type RotationPole = [number, number, number, number, number];

/** Body of /api/rotations (member names are the API's). */
export type RotationModel = {
  maxAge: number;
  anchorPlate: number;
  plates: Record<string, RotationPole[]>;
};

type PoleSequence = { fixedPlate: number; sequenceAges: number[]; quaternions: Quaternion[] };

const MAX_CHAIN_DEPTH = 64;

/**
 * Group a moving plate's poles into runs with the same fixed plate and ascending ages.
 *
 * Usage: once per plate when the tree is built (mirror of server/rotation_tree.py build_sequences).
 *
 * @param plateRows - Poles in file order (several files concatenated).
 * @returns Sequences in file order; earlier ones win where age ranges overlap.
 */
function buildSequences(plateRows: RotationPole[]): PoleSequence[] {
  const sequenceList: PoleSequence[] = [];
  let currentSequence: PoleSequence | null = null;
  for (const [poleAgeMa, poleLatitude, poleLongitude, angleDeg, fixedPlate] of plateRows) {
    const previousAge = currentSequence?.sequenceAges[currentSequence.sequenceAges.length - 1] ?? -Infinity;
    if (!currentSequence || currentSequence.fixedPlate !== fixedPlate || poleAgeMa < previousAge) {
      currentSequence = { fixedPlate, sequenceAges: [], quaternions: [] };
      sequenceList.push(currentSequence);
    }
    currentSequence.sequenceAges.push(poleAgeMa);
    currentSequence.quaternions.push(quatFromPole(poleLatitude, poleLongitude, angleDeg));
  }
  return sequenceList;
}

/**
 * Interpolate a sequence at an age within its range.
 *
 * Usage: RotationTree.relative.
 *
 * @param poleSequence - Sequence covering the age.
 * @param ageInMyr - Age in Ma.
 * @returns The interpolated quaternion.
 */
function interpolateSequence(poleSequence: PoleSequence, ageInMyr: number): Quaternion {
  const sequenceAges = poleSequence.sequenceAges;
  const ageCount = sequenceAges.length;
  if (ageCount === 1) return poleSequence.quaternions[0];
  let lowerIdx = 0;
  let upperIdx = ageCount - 1;
  while (upperIdx - lowerIdx > 1) {
    const middleIdx = (lowerIdx + upperIdx) >> 1;
    if (sequenceAges[middleIdx] <= ageInMyr) lowerIdx = middleIdx;
    else upperIdx = middleIdx;
  }
  const lowerAge = sequenceAges[lowerIdx];
  const upperAge = sequenceAges[upperIdx];
  const fraction = upperAge > lowerAge ? (ageInMyr - lowerAge) / (upperAge - lowerAge) : 0;
  return quatSlerp(poleSequence.quaternions[lowerIdx], poleSequence.quaternions[upperIdx], fraction);
}

export class RotationTree {
  readonly maxAgeMa: number;
  private readonly sequencesByPlate = new Map<number, PoleSequence[]>();
  private memoizedAge = NaN;
  private readonly memoByPlate = new Map<number, Quaternion | null>();

  /**
   * Build the tree from a rotation model.
   *
   * Usage: ``new RotationTree(await fetchRotationModel())``.
   *
   * @param rotationModel - Model from /api/rotations.
   */
  constructor(rotationModel: RotationModel) {
    this.maxAgeMa = rotationModel.maxAge;
    for (const [plateKey, plateRows] of Object.entries(rotationModel.plates)) {
      this.sequencesByPlate.set(Number(plateKey), buildSequences(plateRows));
    }
  }

  /**
   * Rotation of a plate relative to its fixed plate at an age.
   *
   * Usage: one link of the plate chain.
   *
   * @param plateNumber - Moving plate id.
   * @param ageInMyr - Age in Ma.
   * @returns Fixed plate and quaternion, or null when no sequence covers the age.
   */
  relative(plateNumber: number, ageInMyr: number): { fixedPlate: number; rotationQuat: Quaternion } | null {
    const sequenceList = this.sequencesByPlate.get(plateNumber);
    if (!sequenceList) return null;
    for (const poleSequence of sequenceList) {
      const sequenceAges = poleSequence.sequenceAges;
      if (ageInMyr < sequenceAges[0] || ageInMyr > sequenceAges[sequenceAges.length - 1]) continue;
      return { fixedPlate: poleSequence.fixedPlate, rotationQuat: interpolateSequence(poleSequence, ageInMyr) };
    }
    return null;
  }

  /**
   * Rotation of a plate relative to the anchor (spin axis) at an age.
   *
   * Usage: reconstruct geometry. GPlates would fall back to identity where some link
   * has no poles, which snaps the plate to its present-day position; callers hide
   * such geometry instead. Results are memoised per age.
   *
   * @param plateNumber - Plate id (0 = anchor).
   * @param ageInMyr - Age in Ma (≤ 0 = identity).
   * @returns Total quaternion, or null where undefined.
   */
  totalRotation(plateNumber: number, ageInMyr: number): Quaternion | null {
    if (ageInMyr !== this.memoizedAge) {
      this.memoizedAge = ageInMyr;
      this.memoByPlate.clear();
    }
    return this.totalMemoized(plateNumber, ageInMyr, 0);
  }

  /**
   * Recursive, memoised part of totalRotation.
   *
   * Usage: internal.
   *
   * @param plateNumber - Plate id.
   * @param ageInMyr - Age in Ma.
   * @param chainDepth - Recursion depth guard.
   * @returns Total quaternion, or null.
   */
  private totalMemoized(plateNumber: number, ageInMyr: number, chainDepth: number): Quaternion | null {
    if (plateNumber === 0 || ageInMyr <= 0) return IDENTITY_QUAT;
    const memoizedHit = this.memoByPlate.get(plateNumber);
    if (memoizedHit !== undefined) return memoizedHit;
    let totalQuat: Quaternion | null = null;
    const relativeLink = chainDepth < MAX_CHAIN_DEPTH ? this.relative(plateNumber, ageInMyr) : null;
    if (relativeLink) {
      if (relativeLink.fixedPlate === plateNumber || relativeLink.fixedPlate === 0) totalQuat = relativeLink.rotationQuat;
      else {
        const parentQuat = this.totalMemoized(relativeLink.fixedPlate, ageInMyr, chainDepth + 1);
        totalQuat = parentQuat ? quatMultiply(parentQuat, relativeLink.rotationQuat) : null;
      }
    }
    this.memoByPlate.set(plateNumber, totalQuat);
    return totalQuat;
  }
}
