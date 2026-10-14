/**
 * Lifetimes of the topological plates: when each plate id first appears and last
 * exists, which plates no longer exist today (subducted or merged), and the
 * appearance/disappearance events along the timeline.
 */

import type { PlateTopology } from "./topologyModel";

export type PlateLifetime = {
  plateNumber: number;
  /** Oldest age at which the plate exists (Ma). */
  appearAgeMa: number;
  /** Youngest age at which the plate exists (Ma); > 0 for plates that are gone today. */
  vanishAgeMa: number;
  /** Display name of its oldest topology. */
  appearName: string;
  /** Display name of its youngest topology. */
  vanishName: string;
};

export type PlateEventKind = "appear" | "vanish";

/** A plate appearing or disappearing. */
export type PlateEvent = { plateNumber: number; eventKind: PlateEventKind; eventAgeMa: number; plateName: string };

const UPPER_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** A vanish and an appear of the same plate name this close together are a renumbering. */
const RENUMBER_GAP_MYR = 1;

/**
 * Whether a name token is a numeric code: digits, a decimal, or an age range such as "150-147".
 *
 * Usage: plateDisplayName (no regular expression, so no backtracking on odd names).
 *
 * @param nameToken - One whitespace-separated token.
 * @returns True for numbers and number ranges.
 */
function isNumericToken(nameToken: string): boolean {
  const tokenParts = nameToken.split("-");
  return tokenParts.every((tokenPart) => tokenPart !== "" && Number.isFinite(Number(tokenPart)));
}

/**
 * Whether a name token is a topology version code such as "AFR_001_000".
 *
 * Usage: plateDisplayName.
 *
 * @param nameToken - One whitespace-separated token.
 * @returns True for an upper-case prefix (≥ 2 letters) followed by "_digits" groups.
 */
function isVersionCode(nameToken: string): boolean {
  const [codePrefix, ...numberParts] = nameToken.split("_");
  const isPrefix = codePrefix.length >= 2 && [...codePrefix].every((codeLetter) => UPPER_LETTERS.includes(codeLetter));
  return isPrefix && numberParts.length > 0 && numberParts.every((numberPart) => numberPart !== "" && isNumericToken(numberPart));
}

/**
 * Readable form of an underscore-joined token: numeric and age parts dropped, underscores as spaces.
 *
 * Usage: plateDisplayName. "Eurasia_1_0" → "Eurasia", "JUAN_DE_FUCA_11Ma_0Ma" → "JUAN DE FUCA".
 *
 * @param nameToken - One whitespace-separated token.
 * @returns The tidied token (the original when nothing is left).
 */
function tidyToken(nameToken: string): string {
  const keptParts = nameToken.split("_").filter((tokenPart) => tokenPart && !isNumericToken(tokenPart.replace(/Ma$/, "")));
  return keptParts.join(" ") || nameToken;
}

/**
 * Display name of a plate topology.
 *
 * Usage: labels and the events list. "Africa AFR_001_000" → "Africa",
 * "Farallon Plate 150-147" → "Farallon Plate", "PAC_000_000" → "PAC".
 *
 * @param topologyName - Raw topology name from the model.
 * @param plateNumber - Plate id (fallback name).
 * @returns The name without trailing version codes or age ranges, or "Plate <id>".
 */
export function plateDisplayName(topologyName: string, plateNumber: number): string {
  const nameTokens = topologyName.trim().split(/\s+/).filter(Boolean);
  while (nameTokens.length > 1 && (isNumericToken(nameTokens[nameTokens.length - 1]) || isVersionCode(nameTokens[nameTokens.length - 1]))) {
    nameTokens.pop();
  }
  const displayName = nameTokens.map(tidyToken).join(" ");
  return displayName && !isNumericToken(displayName) ? displayName : `Plate ${plateNumber}`;
}

/**
 * Lifetime of every plate id that has topologies.
 *
 * Usage: once after loading the model.
 *
 * @param plateTopologies - All topologies of the model.
 * @returns Lifetimes by plate id (plate 0 is ignored).
 */
export function plateLifetimes(plateTopologies: PlateTopology[]): Map<number, PlateLifetime> {
  const lifetimeMap = new Map<number, PlateLifetime>();
  for (const plateTopology of plateTopologies) {
    if (plateTopology.plateNumber === 0) continue;
    const displayName = plateDisplayName(plateTopology.plateName, plateTopology.plateNumber);
    const knownLifetime = lifetimeMap.get(plateTopology.plateNumber);
    if (!knownLifetime) {
      lifetimeMap.set(plateTopology.plateNumber, {
        plateNumber: plateTopology.plateNumber,
        appearAgeMa: plateTopology.beginAgeMa,
        vanishAgeMa: plateTopology.endAgeMa,
        appearName: displayName,
        vanishName: displayName,
      });
      continue;
    }
    if (plateTopology.beginAgeMa > knownLifetime.appearAgeMa) {
      knownLifetime.appearAgeMa = plateTopology.beginAgeMa;
      knownLifetime.appearName = displayName;
    }
    if (plateTopology.endAgeMa < knownLifetime.vanishAgeMa) {
      knownLifetime.vanishAgeMa = plateTopology.endAgeMa;
      knownLifetime.vanishName = displayName;
    }
  }
  return lifetimeMap;
}

/**
 * Whether a plate no longer exists today (it was subducted or merged into another plate).
 *
 * Usage: the "vanished plates" layer.
 *
 * @param plateLifetime - Lifetime of the plate.
 * @returns True when its last topology ends before the present.
 */
export function isVanishedToday(plateLifetime: PlateLifetime): boolean {
  return plateLifetime.vanishAgeMa > 0;
}

/**
 * Drop vanish/appear pairs that only renumber a plate (same name within RENUMBER_GAP_MYR).
 *
 * Usage: plateEvents. The model sometimes continues a plate under a new plate id;
 * that is not a plate appearing or disappearing.
 *
 * @param eventList - Raw events.
 * @returns Events without renumbering pairs.
 */
function withoutRenumbering(eventList: PlateEvent[]): PlateEvent[] {
  const isRenumbering = (plateEvent: PlateEvent) =>
    eventList.some(
      (otherEvent) =>
        otherEvent.eventKind !== plateEvent.eventKind &&
        otherEvent.plateNumber !== plateEvent.plateNumber &&
        otherEvent.plateName === plateEvent.plateName &&
        Math.abs(otherEvent.eventAgeMa - plateEvent.eventAgeMa) <= RENUMBER_GAP_MYR
    );
  return eventList.filter((plateEvent) => !isRenumbering(plateEvent));
}

/**
 * Appearance and disappearance events inside the model's time range.
 *
 * Usage: once after loading; the events panel and highlights pick the ones near the displayed age.
 *
 * @param lifetimeMap - Lifetimes by plate id.
 * @param modelMaxAgeMa - Oldest age of the timeline; plates existing from then on do not "appear".
 * @returns Events sorted from the oldest to the youngest, without plate renumberings
 *   and without "appearing" at the present.
 */
export function plateEvents(lifetimeMap: Map<number, PlateLifetime>, modelMaxAgeMa: number): PlateEvent[] {
  const eventList: PlateEvent[] = [];
  for (const plateLifetime of lifetimeMap.values()) {
    if (plateLifetime.appearAgeMa < modelMaxAgeMa && plateLifetime.appearAgeMa > 0) {
      eventList.push({
        plateNumber: plateLifetime.plateNumber,
        eventKind: "appear",
        eventAgeMa: plateLifetime.appearAgeMa,
        plateName: plateLifetime.appearName,
      });
    }
    if (isVanishedToday(plateLifetime)) {
      eventList.push({
        plateNumber: plateLifetime.plateNumber,
        eventKind: "vanish",
        eventAgeMa: plateLifetime.vanishAgeMa,
        plateName: plateLifetime.vanishName,
      });
    }
  }
  return withoutRenumbering(eventList).sort((firstEvent, secondEvent) => secondEvent.eventAgeMa - firstEvent.eventAgeMa);
}

/**
 * Events closest to an age.
 *
 * Usage: the events panel next to the timeline.
 *
 * @param eventList - All events (see plateEvents).
 * @param ageInMyr - Displayed age (Ma).
 * @param windowMyr - Maximum distance in time (Myr).
 * @param maxCount - Maximum number of events.
 * @returns Up to maxCount events within the window, nearest first, then ordered oldest to youngest.
 */
export function eventsNear(eventList: PlateEvent[], ageInMyr: number, windowMyr: number, maxCount: number): PlateEvent[] {
  return eventList
    .filter((plateEvent) => Math.abs(plateEvent.eventAgeMa - ageInMyr) <= windowMyr)
    .sort((firstEvent, secondEvent) => Math.abs(firstEvent.eventAgeMa - ageInMyr) - Math.abs(secondEvent.eventAgeMa - ageInMyr))
    .slice(0, maxCount)
    .sort((firstEvent, secondEvent) => secondEvent.eventAgeMa - firstEvent.eventAgeMa);
}

/**
 * Group events by plate.
 *
 * Usage: plate highlights in the tectonic scene.
 *
 * @param eventList - All events.
 * @returns Events per plate id.
 */
export function eventsByPlateNumber(eventList: PlateEvent[]): Map<number, PlateEvent[]> {
  const plateEventMap = new Map<number, PlateEvent[]>();
  for (const plateEvent of eventList) {
    const plateEventList = plateEventMap.get(plateEvent.plateNumber) ?? [];
    plateEventList.push(plateEvent);
    plateEventMap.set(plateEvent.plateNumber, plateEventList);
  }
  return plateEventMap;
}
