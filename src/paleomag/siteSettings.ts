/** Settings of the PINT site layers, read from lod.json ``paleoMagnetics.pintSites``. */

import lodSettings from "../../lod.json";

const siteSection = lodSettings.paleoMagnetics.pintSites;

/** How sites are weighted in time, grouped into poles and turned into field sources. */
export type SiteSettings = {
  /** Narrowest age window (1 σ, Myr) of a site; wider when its age error is larger. */
  minWindowMyr: number;
  /** Widest age window (1 σ, Myr). */
  maxWindowMyr: number;
  /** VGPs closer than this (degrees) to a pole's mean join that pole. */
  clusterRadiusDeg: number;
  /** At most this many poles become magnetic field sources. */
  maxFieldSources: number;
  /** Clusters holding less than this share of the window's weight are not shown as poles. */
  minPoleShare: number;
  /** Poles holding less than this share of the window's weight are not field sources. */
  minSourceShare: number;
  /** Depth of each source's magnetic charges below the centre, in Earth radii (0..1). */
  magnetDepth: number;
};

export const SITE_SETTINGS: SiteSettings = {
  minWindowMyr: siteSection.minWindowMyr,
  maxWindowMyr: siteSection.maxWindowMyr,
  clusterRadiusDeg: siteSection.clusterRadiusDeg,
  maxFieldSources: siteSection.maxFieldSources,
  minPoleShare: siteSection.minPoleShare,
  minSourceShare: siteSection.minSourceShare,
  magnetDepth: siteSection.magnetDepth,
};
