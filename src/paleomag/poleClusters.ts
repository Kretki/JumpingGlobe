/**
 * Geomagnetic poles of the displayed age: the weighted virtual geomagnetic poles of the
 * window's sites are grouped by direction. A stable field gives one pole (with its
 * antipode); during reversals and excursions the VGPs scatter and several poles appear.
 */

import type { UnitVector } from "../plates/sphericalCoords";
import { dotProduct, normalizeOrNull } from "../plates/unitVectorMath";
import type { SitePolarity } from "./pintSites";
import type { SiteSettings } from "./siteSettings";
import { meanMoment, type WindowSite } from "./siteWindow";

/** Moment used when no site of a pole or of the window has one (present-day dipole, 10²² A·m²). */
export const DEFAULT_MOMENT_E22 = 8;

/** One geomagnetic pole (the north pole of a dipole-like source; its south pole is the antipode). */
export type MagneticPole = {
  northUnit: UnitVector;
  /** Dipole moment in 10²² A·m². */
  momentE22: number;
  /** False when the moment is borrowed from the window or the default. */
  momentMeasured: boolean;
  /** Share of the window's site weight, 0..1. */
  weightShare: number;
  siteCount: number;
  polarityCounts: Record<SitePolarity, number>;
  /** Weighted mean angle (degrees) of its VGPs from the pole. */
  spreadDeg: number;
};

/** A pole being collected. */
type PoleGroup = { summedVector: UnitVector; meanUnit: UnitVector; memberSites: WindowSite[] };

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Add a site to the nearest group within the radius, or start a new group.
 *
 * Usage: clusterPoles, sites in decreasing weight.
 *
 * @param poleGroups - Groups so far (mutated).
 * @param windowSite - Site with a VGP.
 * @param cosRadius - Cosine of the cluster radius.
 * @returns Nothing.
 */
function addToGroup(poleGroups: PoleGroup[], windowSite: WindowSite, cosRadius: number): void {
  const siteVgpUnit = windowSite.vgpUnit!;
  let bestGroup: PoleGroup | null = null;
  let bestCosine = cosRadius;
  for (const poleGroup of poleGroups) {
    const groupCosine = dotProduct(poleGroup.meanUnit, siteVgpUnit);
    if (groupCosine >= bestCosine) {
      bestCosine = groupCosine;
      bestGroup = poleGroup;
    }
  }
  if (!bestGroup) {
    poleGroups.push({ summedVector: [0, 0, 0], meanUnit: siteVgpUnit, memberSites: [] });
    bestGroup = poleGroups[poleGroups.length - 1];
  }
  for (let axisIndex = 0; axisIndex < 3; axisIndex++) bestGroup.summedVector[axisIndex] += windowSite.ageWeight * siteVgpUnit[axisIndex];
  bestGroup.meanUnit = normalizeOrNull(bestGroup.summedVector) ?? bestGroup.meanUnit;
  bestGroup.memberSites.push(windowSite);
}

/**
 * Merge groups whose means lie within the cluster radius, closest pair first, until none do.
 *
 * Usage: clusterPoles, after the greedy pass (early groups start before their means settle).
 *
 * @param poleGroups - Groups (mutated: merged groups are removed).
 * @param cosRadius - Cosine of the cluster radius.
 * @returns Nothing.
 */
function mergeCloseGroups(poleGroups: PoleGroup[], cosRadius: number): void {
  for (;;) {
    let bestPair: [number, number] | null = null;
    let bestCosine = cosRadius;
    for (let firstIndex = 0; firstIndex < poleGroups.length; firstIndex++) {
      for (let secondIndex = firstIndex + 1; secondIndex < poleGroups.length; secondIndex++) {
        const pairCosine = dotProduct(poleGroups[firstIndex].meanUnit, poleGroups[secondIndex].meanUnit);
        if (pairCosine >= bestCosine) {
          bestCosine = pairCosine;
          bestPair = [firstIndex, secondIndex];
        }
      }
    }
    if (!bestPair) return;
    const [keptGroup, mergedGroup] = [poleGroups[bestPair[0]], poleGroups[bestPair[1]]];
    for (let axisIndex = 0; axisIndex < 3; axisIndex++) keptGroup.summedVector[axisIndex] += mergedGroup.summedVector[axisIndex];
    keptGroup.meanUnit = normalizeOrNull(keptGroup.summedVector) ?? keptGroup.meanUnit;
    keptGroup.memberSites.push(...mergedGroup.memberSites);
    poleGroups.splice(bestPair[1], 1);
  }
}

/**
 * Summarise a group as a pole.
 *
 * Usage: clusterPoles.
 *
 * @param poleGroup - Group.
 * @param totalWeight - Weight of every site with a VGP.
 * @param windowMoment - Mean moment of the whole window (fallback).
 * @returns The pole.
 */
function poleOfGroup(poleGroup: PoleGroup, totalWeight: number, windowMoment: number): MagneticPole {
  const polarityCounts: Record<SitePolarity, number> = { N: 0, R: 0, T: 0, U: 0 };
  let groupWeight = 0;
  let spreadSum = 0;
  for (const memberSite of poleGroup.memberSites) {
    polarityCounts[memberSite.polarity] += 1;
    groupWeight += memberSite.ageWeight;
    spreadSum += memberSite.ageWeight * Math.acos(Math.min(1, dotProduct(poleGroup.meanUnit, memberSite.vgpUnit!)));
  }
  const groupMoment = meanMoment(poleGroup.memberSites);
  const fallbackMoment = Number.isFinite(windowMoment) ? windowMoment : DEFAULT_MOMENT_E22;
  return {
    northUnit: poleGroup.meanUnit,
    momentE22: Number.isFinite(groupMoment) ? groupMoment : fallbackMoment,
    momentMeasured: Number.isFinite(groupMoment),
    weightShare: totalWeight > 0 ? groupWeight / totalWeight : 0,
    siteCount: poleGroup.memberSites.length,
    polarityCounts,
    spreadDeg: groupWeight > 0 ? (spreadSum / groupWeight) * RAD_TO_DEG : 0,
  };
}

/**
 * Group the window's VGPs into poles.
 *
 * Usage: whenever the displayed age changes.
 *
 * @param windowSites - Sites of the window (those without a VGP only inform the strength).
 * @param siteSettings - Cluster radius and minimum pole share.
 * @returns Poles holding at least minPoleShare of the weight, by decreasing share ([] without VGPs).
 */
export function clusterPoles(windowSites: WindowSite[], siteSettings: SiteSettings): MagneticPole[] {
  const directedSites = windowSites.filter((windowSite) => windowSite.vgpUnit !== null).sort((firstSite, secondSite) => secondSite.ageWeight - firstSite.ageWeight);
  const cosRadius = Math.cos((siteSettings.clusterRadiusDeg * Math.PI) / 180);
  const poleGroups: PoleGroup[] = [];
  for (const directedSite of directedSites) addToGroup(poleGroups, directedSite, cosRadius);
  mergeCloseGroups(poleGroups, cosRadius);
  const totalWeight = directedSites.reduce((weightSum, directedSite) => weightSum + directedSite.ageWeight, 0);
  const windowMoment = meanMoment(windowSites);
  return poleGroups
    .map((poleGroup) => poleOfGroup(poleGroup, totalWeight, windowMoment))
    .filter((magneticPole) => magneticPole.weightShare >= siteSettings.minPoleShare)
    .sort((firstPole, secondPole) => secondPole.weightShare - firstPole.weightShare);
}
