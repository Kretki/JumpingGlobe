/**
 * Magnetic sources of the displayed age: every strong enough pole becomes a buried bar
 * magnet, a pair of opposite magnetic charges on its axis at SiteSettings.magnetDepth from
 * the centre. The charge under the geomagnetic north pole is negative (field lines enter
 * there, as in today's northern hemisphere), the one under its antipode positive, and
 * their size is the pole's share of the dipole moment. The field is the sum over all
 * charges, so several poles give a multipolar field.
 */

import type { UnitVector } from "../plates/sphericalCoords";
import type { MagneticPole } from "./poleClusters";
import type { SiteSettings } from "./siteSettings";

/** A point charge of the field model. */
export type MagneticCharge = {
  /** Position in Earth radii. */
  chargePosition: UnitVector;
  /** Signed strength (positive = field lines leave), in 10²² A·m² units of moment share. */
  chargeStrength: number;
  /** Ground point above the charge (where its tube meets the surface). */
  groundUnit: UnitVector;
};

/**
 * Poles that act as sources.
 *
 * Usage: buildFieldCharges and labels.
 *
 * @param magneticPoles - Poles sorted by weight share.
 * @param siteSettings - Source limits.
 * @returns The strongest poles above the minimum share, at most maxFieldSources.
 */
export function sourcePoles(magneticPoles: MagneticPole[], siteSettings: SiteSettings): MagneticPole[] {
  return magneticPoles.filter((magneticPole) => magneticPole.weightShare >= siteSettings.minSourceShare).slice(0, siteSettings.maxFieldSources);
}

/**
 * Charges of the field model.
 *
 * Usage: whenever the poles change.
 *
 * @param magneticPoles - Poles of the displayed age.
 * @param siteSettings - Source limits and magnet depth.
 * @returns Two charges per source pole ([] without poles).
 */
export function buildFieldCharges(magneticPoles: MagneticPole[], siteSettings: SiteSettings): MagneticCharge[] {
  const fieldCharges: MagneticCharge[] = [];
  for (const sourcePole of sourcePoles(magneticPoles, siteSettings)) {
    const chargeSize = sourcePole.weightShare * sourcePole.momentE22;
    const northUnit = sourcePole.northUnit;
    const southUnit: UnitVector = [-northUnit[0], -northUnit[1], -northUnit[2]];
    for (const [groundUnit, chargeSign] of [
      [northUnit, -1],
      [southUnit, 1],
    ] as const) {
      fieldCharges.push({
        chargePosition: [groundUnit[0] * siteSettings.magnetDepth, groundUnit[1] * siteSettings.magnetDepth, groundUnit[2] * siteSettings.magnetDepth],
        chargeStrength: chargeSign * chargeSize,
        groundUnit,
      });
    }
  }
  return fieldCharges;
}

/**
 * Field of the charges at a point (Coulomb-like, 1/r²).
 *
 * Usage: field-line tracing.
 *
 * @param fieldCharges - Charges.
 * @param pointPosX - Point x (Earth radii).
 * @param pointPosY - Point y.
 * @param pointPosZ - Point z.
 * @param fieldOut - Receives the field vector (mutated).
 * @returns Nothing.
 */
export function fieldAtPoint(fieldCharges: MagneticCharge[], pointPosX: number, pointPosY: number, pointPosZ: number, fieldOut: UnitVector): void {
  fieldOut[0] = 0;
  fieldOut[1] = 0;
  fieldOut[2] = 0;
  for (const fieldCharge of fieldCharges) {
    const offsetVecX = pointPosX - fieldCharge.chargePosition[0];
    const offsetVecY = pointPosY - fieldCharge.chargePosition[1];
    const offsetVecZ = pointPosZ - fieldCharge.chargePosition[2];
    const distanceSquared = offsetVecX * offsetVecX + offsetVecY * offsetVecY + offsetVecZ * offsetVecZ + 1e-9;
    const fieldScale = fieldCharge.chargeStrength / (distanceSquared * Math.sqrt(distanceSquared));
    fieldOut[0] += fieldScale * offsetVecX;
    fieldOut[1] += fieldScale * offsetVecY;
    fieldOut[2] += fieldScale * offsetVecZ;
  }
}
