/** Paleomagnetic poles of the displayed age, placed on the globe with the plate model. */

import { quatRotate } from "../plates/quaternionMath";
import { lonLatToUnit, type UnitVector } from "../plates/sphericalCoords";
import type { RotationLookup } from "../plates/topology/rotationCache";
import { normalizeOrNull } from "../plates/unitVectorMath";
import type { PaleoPole } from "./paleomagModel";

/** A pole moved with its block to the displayed age. */
export type PlacedPole = { paleoPole: PaleoPole; northUnit: UnitVector };

/**
 * Poles whose age window contains an age, rotated with their block's plate.
 *
 * Usage: whenever the displayed age changes; an empty list means "no paleomagnetic data".
 *
 * @param paleoPoles - All poles.
 * @param rotationLookup - Plate rotations of the displayed model.
 * @param ageInMyr - Age in Ma.
 * @returns Placed north poles (poles of unmapped blocks or plates without rotation are left out).
 */
export function polesAtAge(paleoPoles: PaleoPole[], rotationLookup: RotationLookup, ageInMyr: number): PlacedPole[] {
  const placedPoles: PlacedPole[] = [];
  for (const paleoPole of paleoPoles) {
    if (paleoPole.plateNumber === null || ageInMyr < paleoPole.youngAgeMa || ageInMyr > paleoPole.oldAgeMa) continue;
    const plateRotation = rotationLookup.rotationAt(paleoPole.plateNumber, ageInMyr);
    if (!plateRotation) continue;
    const presentUnit = lonLatToUnit(paleoPole.longitudeDeg, paleoPole.latitudeDeg);
    const northUnit: UnitVector = [0, 0, 0];
    quatRotate(plateRotation, presentUnit[0], presentUnit[1], presentUnit[2], northUnit);
    placedPoles.push({ paleoPole, northUnit });
  }
  return placedPoles;
}

/**
 * Mean north pole of several placed poles (vector mean).
 *
 * Usage: axis of the dipole whose field lines are drawn.
 *
 * @param placedPoles - Poles of the displayed age.
 * @returns Unit mean direction, or null when there is none (or they cancel out).
 */
export function meanPoleAxis(placedPoles: PlacedPole[]): UnitVector | null {
  const summedVector: UnitVector = [0, 0, 0];
  for (const placedPole of placedPoles) {
    for (let axisIndex = 0; axisIndex < 3; axisIndex++) summedVector[axisIndex] += placedPole.northUnit[axisIndex];
  }
  return placedPoles.length ? normalizeOrNull(summedVector) : null;
}
