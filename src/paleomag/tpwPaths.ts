/**
 * True-polar-wander paths: where the spin axis was at an age, relative to a mantle
 * reference frame (Vaes et al. 2023 GAPWAP supplement). Path poles are given every
 * 10 Myr in mantle-frame coordinates, which the globe shows as its own longitude/latitude
 * grid; between them the pole moves along the great circle.
 */

import { quatRotate, type Quaternion } from "../plates/quaternionMath";
import { lonLatToUnit, type UnitVector } from "../plates/sphericalCoords";
import { crossProduct, normalizeOrNull, pointAlongArc } from "../plates/unitVectorMath";
import type { NetAngleSample, TpwPath, TpwRateSample } from "./paleomagModel";

/** The spin axis of one TPW path at one age. */
export type TpwFrame = {
  /** Smallest rotation taking the globe's north pole to the spin axis (orients the TPW grid). */
  frameQuat: Quaternion;
  /** North spin axis on the globe. */
  spinAxisUnit: UnitVector;
  /** 95 % confidence radius of the pole in degrees, or null. */
  confidenceDeg: number | null;
  frameLabel: string;
  /** The whole path, oldest last (drawn as a track). */
  pathUnits: UnitVector[];
};

/** A path prepared for interpolation. */
type PreparedPath = { frameLabel: string; pathAges: number[]; pathUnits: UnitVector[]; pathConfidences: (number | null)[] };

/** Option of the frame dropdown. */
export type TpwFrameOption = { frameKey: string; frameLabel: string };

/**
 * Rotate a unit vector by a quaternion.
 *
 * Usage: place spin-frame points on the globe.
 *
 * @param rotationQuat - Rotation.
 * @param inputUnit - Vector.
 * @returns The rotated vector.
 */
export function rotateUnit(rotationQuat: Quaternion, inputUnit: UnitVector): UnitVector {
  const rotatedUnit: UnitVector = [0, 0, 0];
  quatRotate(rotationQuat, inputUnit[0], inputUnit[1], inputUnit[2], rotatedUnit);
  return rotatedUnit;
}

/**
 * Smallest rotation taking the north pole (0, 0, 1) to a direction.
 *
 * Usage: orient the TPW grid around a spin axis.
 *
 * @param targetUnit - Unit direction.
 * @returns Unit quaternion [w, x, y, z].
 */
export function rotationFromNorth(targetUnit: UnitVector): Quaternion {
  const turnAngle = Math.acos(Math.min(1, Math.max(-1, targetUnit[2])));
  const turnAxis = normalizeOrNull(crossProduct([0, 0, 1], targetUnit)) ?? [1, 0, 0];
  const halfSine = Math.sin(turnAngle / 2);
  return [Math.cos(turnAngle / 2), turnAxis[0] * halfSine, turnAxis[1] * halfSine, turnAxis[2] * halfSine];
}

/**
 * Linear interpolation of a sampled series at an age.
 *
 * Usage: rate notes.
 *
 * @param sampleAges - Sample ages, ascending.
 * @param sampleValues - Values (null = no value at that age).
 * @param ageInMyr - Age in Ma.
 * @returns The value between the nearest samples with values, or null outside them.
 */
export function interpolateSeries(sampleAges: number[], sampleValues: (number | null)[], ageInMyr: number): number | null {
  const knownIndices = sampleValues.flatMap((sampleValue, sampleIndex) => (sampleValue === null ? [] : [sampleIndex]));
  for (let knownIdx = 0; knownIdx < knownIndices.length; knownIdx++) {
    const upperIndex = knownIndices[knownIdx];
    if (ageInMyr > sampleAges[upperIndex]) continue;
    if (ageInMyr === sampleAges[upperIndex]) return sampleValues[upperIndex];
    if (knownIdx === 0) return null;
    const lowerIndex = knownIndices[knownIdx - 1];
    const spanFraction = (ageInMyr - sampleAges[lowerIndex]) / (sampleAges[upperIndex] - sampleAges[lowerIndex]);
    return sampleValues[lowerIndex]! + (sampleValues[upperIndex]! - sampleValues[lowerIndex]!) * spanFraction;
  }
  return null;
}

export class TpwPaths {
  private readonly pathsByKey = new Map<string, PreparedPath>();
  /** Dropdown options, in data order (the first one is the default). */
  readonly frameOptions: TpwFrameOption[];

  /**
   * Prepare the paths.
   *
   * Usage: once when the paleomagnetic data arrived.
   *
   * @param tpwPaths - Validated paths (sorted by age).
   */
  constructor(tpwPaths: TpwPath[]) {
    for (const pathEntry of tpwPaths) {
      this.pathsByKey.set(pathEntry.frameKey, {
        frameLabel: pathEntry.frameLabel,
        pathAges: pathEntry.pathPoints.map((pathPoint) => pathPoint.ageMa),
        pathUnits: pathEntry.pathPoints.map((pathPoint) => lonLatToUnit(pathPoint.longitudeDeg, pathPoint.latitudeDeg)),
        pathConfidences: pathEntry.pathPoints.map((pathPoint) => pathPoint.confidenceDeg),
      });
    }
    this.frameOptions = tpwPaths.map((pathEntry) => ({ frameKey: pathEntry.frameKey, frameLabel: pathEntry.frameLabel }));
  }

  /**
   * Ages a path covers.
   *
   * Usage: coverage note.
   *
   * @param frameKey - Path key.
   * @returns [youngest, oldest] in Ma, or null for an unknown key.
   */
  coveredSpan(frameKey: string): [number, number] | null {
    const preparedPath = this.pathsByKey.get(frameKey);
    return preparedPath ? [preparedPath.pathAges[0], preparedPath.pathAges[preparedPath.pathAges.length - 1]] : null;
  }

  /**
   * The spin axis of a path at an age.
   *
   * Usage: whenever the age or the chosen path changes; null means "no TPW data for this age".
   *
   * @param frameKey - Path key.
   * @param ageInMyr - Age in Ma.
   * @returns The frame, or null outside the path's ages (or for an unknown key).
   */
  frameAtAge(frameKey: string, ageInMyr: number): TpwFrame | null {
    const preparedPath = this.pathsByKey.get(frameKey);
    if (!preparedPath) return null;
    const { pathAges, pathUnits, pathConfidences } = preparedPath;
    if (ageInMyr < pathAges[0] || ageInMyr > pathAges[pathAges.length - 1]) return null;
    let upperIndex = pathAges.findIndex((pathAgeMa) => pathAgeMa >= ageInMyr);
    upperIndex = Math.max(upperIndex, 0);
    const lowerIndex = Math.max(upperIndex - 1, 0);
    const ageSpanMyr = pathAges[upperIndex] - pathAges[lowerIndex];
    const spanFraction = ageSpanMyr > 0 ? (ageInMyr - pathAges[lowerIndex]) / ageSpanMyr : 0;
    const spinAxisUnit = pointAlongArc(pathUnits[lowerIndex], pathUnits[upperIndex], spanFraction);
    const lowerConfidence = pathConfidences[lowerIndex];
    const upperConfidence = pathConfidences[upperIndex];
    const confidenceDeg =
      lowerConfidence !== null && upperConfidence !== null ? lowerConfidence + (upperConfidence - lowerConfidence) * spanFraction : (upperConfidence ?? lowerConfidence);
    return { frameQuat: rotationFromNorth(spinAxisUnit), spinAxisUnit, confidenceDeg, frameLabel: preparedPath.frameLabel, pathUnits };
  }
}

/**
 * Polar-wander rate and net TPW angle at an age, as one line of text.
 *
 * Usage: note under the TPW checkboxes.
 *
 * @param tpwRates - Polar-wander rates (V23), sorted by age.
 * @param netAngles - Torsvik et al. TPW rates and net angles (T14), sorted by age.
 * @param ageInMyr - Age in Ma.
 * @returns e.g. "PW rate 0.35 (0.24–0.47)°/Myr · T14: 0.44°/Myr, net TPW −13.2°"; "" without data.
 */
export function tpwRateNote(tpwRates: TpwRateSample[], netAngles: NetAngleSample[], ageInMyr: number): string {
  const rateAges = tpwRates.map((rateSample) => rateSample.ageMa);
  const rateValue = interpolateSeries(rateAges, tpwRates.map((rateSample) => rateSample.rateDegPerMyr), ageInMyr);
  const lowValue = interpolateSeries(rateAges, tpwRates.map((rateSample) => rateSample.rateLowDegPerMyr), ageInMyr);
  const highValue = interpolateSeries(rateAges, tpwRates.map((rateSample) => rateSample.rateHighDegPerMyr), ageInMyr);
  const angleAges = netAngles.map((angleSample) => angleSample.ageMa);
  const torsvikRate = interpolateSeries(angleAges, netAngles.map((angleSample) => angleSample.rateDegPerMyr), ageInMyr);
  const netAngle = interpolateSeries(angleAges, netAngles.map((angleSample) => angleSample.netAngleDeg), ageInMyr);
  const noteParts: string[] = [];
  if (rateValue !== null) {
    const boundsText = lowValue !== null && highValue !== null ? ` (${lowValue.toFixed(2)}–${highValue.toFixed(2)})` : "";
    noteParts.push(`PW rate ${rateValue.toFixed(2)}${boundsText}°/Myr`);
  }
  const torsvikParts = [torsvikRate !== null ? `${torsvikRate.toFixed(2)}°/Myr` : "", netAngle !== null ? `net TPW ${netAngle.toFixed(1)}°` : ""].filter(Boolean);
  if (torsvikParts.length) noteParts.push(`T14: ${torsvikParts.join(", ")}`);
  return noteParts.join(" · ");
}
