/** The geomagnetic field of one age, derived from the PINT sites: window → poles → sources. */

import type { RotationLookup } from "../plates/topology/rotationCache";
import { buildFieldCharges, type MagneticCharge } from "./fieldSources";
import { momentText } from "./magneticMarkers";
import type { PintSites, SitePolarity } from "./pintSites";
import { clusterPoles, type MagneticPole } from "./poleClusters";
import type { SiteSettings } from "./siteSettings";
import { meanMoment, sitesAtAge, type WindowSite } from "./siteWindow";

/** Everything the magnetic layers draw for one age. */
export type MagneticField = {
  windowSites: WindowSite[];
  /** Poles, strongest first (empty when no site of the window has a placeable VGP). */
  magneticPoles: MagneticPole[];
  fieldCharges: MagneticCharge[];
  /** Weighted mean dipole moment of the window (10²² A·m²), NaN when unknown. */
  windowMomentE22: number;
};

/**
 * Derive the field at an age.
 *
 * Usage: whenever the displayed age or the rotation model changes.
 *
 * @param pintSites - All sites.
 * @param rotationLookup - Plate rotations.
 * @param ageInMyr - Displayed age.
 * @param siteSettings - Window, cluster and source settings.
 * @returns The field (possibly without poles).
 */
export function magneticFieldAt(pintSites: PintSites, rotationLookup: RotationLookup, ageInMyr: number, siteSettings: SiteSettings): MagneticField {
  const windowSites = sitesAtAge(pintSites, rotationLookup, ageInMyr, siteSettings);
  const magneticPoles = clusterPoles(windowSites, siteSettings);
  return { windowSites, magneticPoles, fieldCharges: buildFieldCharges(magneticPoles, siteSettings), windowMomentE22: meanMoment(windowSites) };
}

/**
 * One-line summary of the field.
 *
 * Usage: note under the magnetic checkboxes.
 *
 * @param magneticField - Field of the displayed age.
 * @param ageInMyr - Displayed age.
 * @returns e.g. "2 poles · field 7.9×10²² A·m² · 40 sites (N 31, R 6, T 3)".
 */
export function magneticFieldNote(magneticField: MagneticField, ageInMyr: number): string {
  const directedSites = magneticField.windowSites.filter((windowSite) => windowSite.vgpUnit !== null);
  if (!magneticField.magneticPoles.length) {
    return magneticField.windowSites.length ? `No site direction near ${ageInMyr} Ma` : `No PINT site near ${ageInMyr} Ma`;
  }
  const polarityCounts: Record<SitePolarity, number> = { N: 0, R: 0, T: 0, U: 0 };
  for (const directedSite of directedSites) polarityCounts[directedSite.polarity] += 1;
  const polarityText = (["N", "R", "T", "U"] as const)
    .filter((polarityLetter) => polarityCounts[polarityLetter] > 0)
    .map((polarityLetter) => `${polarityLetter === "U" ? "?" : polarityLetter} ${polarityCounts[polarityLetter]}`)
    .join(", ");
  const poleCount = magneticField.magneticPoles.length;
  const strengthText = Number.isFinite(magneticField.windowMomentE22) ? ` · field ${momentText(magneticField.windowMomentE22)}` : "";
  return `${poleCount} pole${poleCount === 1 ? "" : "s"}${strengthText} · ${directedSites.length} sites (${polarityText})`;
}
