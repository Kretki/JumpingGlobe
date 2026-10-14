/**
 * PINT sites around the displayed age: each site is weighted by the probability that it
 * dates from that age (a Gaussian whose width is its age error, kept between the configured
 * limits, so loosely dated sites count less) and its virtual geomagnetic pole is moved with
 * the site's plate to the displayed age.
 */

import { quatRotate } from "../plates/quaternionMath";
import { lonLatToUnit, type UnitVector } from "../plates/sphericalCoords";
import type { RotationLookup } from "../plates/topology/rotationCache";
import type { PintSites, SitePolarity } from "./pintSites";
import type { SiteSettings } from "./siteSettings";

/** Sites further than ≈ 2.5 σ from the displayed age are left out. */
const MIN_SITE_CLOSENESS = 0.04;

/** One site of the window. */
export type WindowSite = {
  siteIndex: number;
  /** Age weight: Gaussian closeness times minWindowMyr / σ (≤ 1). */
  ageWeight: number;
  /** Gaussian closeness alone, 0..1 (how well the site matches the age, ignoring its precision). */
  ageCloseness: number;
  polarity: SitePolarity;
  /** Dipole moment in 10²² A·m², NaN when unknown. */
  momentE22: number;
  /** VGP on the globe at the displayed age, or null (no direction, or the plate cannot be placed). */
  vgpUnit: UnitVector | null;
};

/**
 * Width (1 σ, Myr) of a site's age window.
 *
 * Usage: sitesAtAge.
 *
 * @param siteError - Age error (Myr).
 * @param siteSettings - Window limits.
 * @returns The error clamped to [minWindowMyr, maxWindowMyr].
 */
export function windowSigma(siteError: number, siteSettings: SiteSettings): number {
  return Math.min(siteSettings.maxWindowMyr, Math.max(siteSettings.minWindowMyr, siteError));
}

/**
 * How well a site's age matches the displayed age.
 *
 * Usage: sitesAtAge.
 *
 * @param siteAgeMa - Site age (Ma).
 * @param siteError - Age error (Myr).
 * @param ageInMyr - Displayed age.
 * @param siteSettings - Window limits.
 * @returns exp(-½ (Δt/σ)²).
 */
export function ageCloseness(siteAgeMa: number, siteError: number, ageInMyr: number, siteSettings: SiteSettings): number {
  const sigmaDistance = (siteAgeMa - ageInMyr) / windowSigma(siteError, siteSettings);
  return Math.exp(-0.5 * sigmaDistance * sigmaDistance);
}

/**
 * VGP of a site placed on the globe at the displayed age.
 *
 * Usage: sitesAtAge.
 *
 * @param pintSites - Sites.
 * @param siteIndex - Site.
 * @param rotationLookup - Plate rotations.
 * @param ageInMyr - Displayed age.
 * @returns Unit vector, or null without a direction or plate rotation.
 */
function placedVgp(pintSites: PintSites, siteIndex: number, rotationLookup: RotationLookup, ageInMyr: number): UnitVector | null {
  const poleLatitude = pintSites.vgpLat[siteIndex];
  const poleLongitude = pintSites.vgpLon[siteIndex];
  if (!Number.isFinite(poleLatitude) || !Number.isFinite(poleLongitude)) return null;
  const presentUnit = lonLatToUnit(poleLongitude, poleLatitude);
  if (ageInMyr <= 0) return presentUnit;
  const plateNumber = pintSites.plateNumber[siteIndex];
  const plateRotation = plateNumber >= 0 ? rotationLookup.rotationAt(plateNumber, ageInMyr) : null;
  if (!plateRotation) return null;
  const rotatedUnit: UnitVector = [0, 0, 0];
  quatRotate(plateRotation, presentUnit[0], presentUnit[1], presentUnit[2], rotatedUnit);
  return rotatedUnit;
}

/**
 * Sites that inform the field at an age.
 *
 * Usage: whenever the displayed age changes.
 *
 * @param pintSites - All sites (sorted by age).
 * @param rotationLookup - Plate rotations of the displayed model.
 * @param ageInMyr - Displayed age.
 * @param siteSettings - Window limits.
 * @returns Sites within ≈ 2.5 σ of the age.
 */
export function sitesAtAge(pintSites: PintSites, rotationLookup: RotationLookup, ageInMyr: number, siteSettings: SiteSettings): WindowSite[] {
  const windowSites: WindowSite[] = [];
  for (let siteIndex = 0; siteIndex < pintSites.siteCount; siteIndex++) {
    const siteError = pintSites.ageError[siteIndex];
    const siteCloseness = ageCloseness(pintSites.ageMa[siteIndex], siteError, ageInMyr, siteSettings);
    if (siteCloseness < MIN_SITE_CLOSENESS) continue;
    windowSites.push({
      siteIndex,
      ageWeight: (siteCloseness * siteSettings.minWindowMyr) / windowSigma(siteError, siteSettings),
      ageCloseness: siteCloseness,
      polarity: pintSites.polarity[siteIndex],
      momentE22: pintSites.momentE22[siteIndex],
      vgpUnit: placedVgp(pintSites, siteIndex, rotationLookup, ageInMyr),
    });
  }
  return windowSites;
}

/**
 * Weighted mean dipole moment of a set of sites.
 *
 * Usage: pole strength and the window's field strength.
 *
 * @param windowSites - Sites (those without a moment are ignored).
 * @returns Mean in 10²² A·m², or NaN when no site has a moment.
 */
export function meanMoment(windowSites: WindowSite[]): number {
  let weightedSum = 0;
  let weightSum = 0;
  for (const windowSite of windowSites) {
    if (!Number.isFinite(windowSite.momentE22)) continue;
    weightedSum += windowSite.ageWeight * windowSite.momentE22;
    weightSum += windowSite.ageWeight;
  }
  return weightSum > 0 ? weightedSum / weightSum : NaN;
}
