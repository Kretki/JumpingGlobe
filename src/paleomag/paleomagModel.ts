/** Typed, validated form of /api/paleomag: paleomagnetic poles, TPW paths, polar-wander rates and net TPW angles. */

/** A paleomagnetic (north) pole of a block, in present-day coordinates of that block. */
export type PaleoPole = {
  poleName: string;
  block: string;
  /** Plate of the rotation model the block moves with (null when unmapped). */
  plateNumber: number | null;
  rockUnit: string;
  ageText: string;
  youngAgeMa: number;
  oldAgeMa: number;
  latitudeDeg: number;
  longitudeDeg: number;
  /** 95 % confidence radius in degrees (null when not given). */
  confidenceDeg: number | null;
};

/** A spin-axis (north) pole of a TPW path, in mantle-frame coordinates. */
export type TpwPathPoint = { ageMa: number; longitudeDeg: number; latitudeDeg: number; confidenceDeg: number | null };

/** One TPW path (spin axis relative to a mantle reference frame), sorted by age. */
export type TpwPath = { frameKey: string; frameLabel: string; pathPoints: TpwPathPoint[] };

/** Polar-wander rate at an age, with its bounds (degrees per Myr). */
export type TpwRateSample = { ageMa: number; rateDegPerMyr: number; rateLowDegPerMyr: number | null; rateHighDegPerMyr: number | null };

/** TPW rate and net TPW rotation angle at an age (either may be missing). */
export type NetAngleSample = { ageMa: number; rateDegPerMyr: number | null; netAngleDeg: number | null };

export type PaleoMagData = { paleoPoles: PaleoPole[]; tpwPaths: TpwPath[]; tpwRates: TpwRateSample[]; tpwNetAngles: NetAngleSample[] };

type RawRecord = Record<string, unknown>;

/**
 * Narrow an unknown value to a plain object.
 *
 * Usage: response validation.
 *
 * @param candidate - Value to check.
 * @returns True for non-null, non-array objects.
 */
function isRecord(candidate: unknown): candidate is RawRecord {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

/**
 * A finite number field, or null.
 *
 * Usage: numeric fields.
 *
 * @param fieldValue - Raw value.
 * @returns The number, or null when missing or not finite.
 */
function finiteOrNull(fieldValue: unknown): number | null {
  return typeof fieldValue === "number" && Number.isFinite(fieldValue) ? fieldValue : null;
}

/**
 * A string field, or "".
 *
 * Usage: text fields.
 *
 * @param fieldValue - Raw value.
 * @returns The string, or "".
 */
function textOrEmpty(fieldValue: unknown): string {
  return typeof fieldValue === "string" ? fieldValue : "";
}

/**
 * Validate one pole.
 *
 * Usage: parsePaleoMagData.
 *
 * @param rawPoleEntry - Pole object from the response.
 * @returns The pole, or null when its position or ages are invalid.
 */
function parsePole(rawPoleEntry: unknown): PaleoPole | null {
  if (!isRecord(rawPoleEntry)) return null;
  const latitudeDeg = finiteOrNull(rawPoleEntry.latitudeDeg);
  const longitudeDeg = finiteOrNull(rawPoleEntry.longitudeDeg);
  const youngAgeMa = finiteOrNull(rawPoleEntry.youngAgeMa);
  const oldAgeMa = finiteOrNull(rawPoleEntry.oldAgeMa);
  if (latitudeDeg === null || longitudeDeg === null || youngAgeMa === null || oldAgeMa === null || Math.abs(latitudeDeg) > 90) return null;
  const confidenceDeg = finiteOrNull(rawPoleEntry.confidenceDeg);
  return {
    poleName: textOrEmpty(rawPoleEntry.poleName),
    block: textOrEmpty(rawPoleEntry.block),
    plateNumber: finiteOrNull(rawPoleEntry.plateId),
    rockUnit: textOrEmpty(rawPoleEntry.rockUnit),
    ageText: textOrEmpty(rawPoleEntry.ageText),
    youngAgeMa: Math.min(youngAgeMa, oldAgeMa),
    oldAgeMa: Math.max(youngAgeMa, oldAgeMa),
    latitudeDeg,
    longitudeDeg,
    confidenceDeg: confidenceDeg !== null && confidenceDeg > 0 && confidenceDeg < 90 ? confidenceDeg : null,
  };
}

/**
 * Validate one point of a TPW path.
 *
 * Usage: parsePath.
 *
 * @param rawPoint - Point object from the response.
 * @returns The point, or null when its age or position is invalid.
 */
function parsePathPoint(rawPoint: unknown): TpwPathPoint | null {
  if (!isRecord(rawPoint)) return null;
  const pointAgeMa = finiteOrNull(rawPoint.ageMa);
  const longitudeDeg = finiteOrNull(rawPoint.longitudeDeg);
  const latitudeDeg = finiteOrNull(rawPoint.latitudeDeg);
  if (pointAgeMa === null || longitudeDeg === null || latitudeDeg === null || Math.abs(latitudeDeg) > 90) return null;
  const confidenceDeg = finiteOrNull(rawPoint.confidenceDeg);
  return { ageMa: pointAgeMa, longitudeDeg, latitudeDeg, confidenceDeg: confidenceDeg !== null && confidenceDeg >= 0 && confidenceDeg < 90 ? confidenceDeg : null };
}

/**
 * Validate one TPW path.
 *
 * Usage: parsePaleoMagData.
 *
 * @param rawPathEntry - Path object from the response.
 * @returns The path sorted by age, or null when it has no key or no point.
 */
function parsePath(rawPathEntry: unknown): TpwPath | null {
  if (!isRecord(rawPathEntry) || !Array.isArray(rawPathEntry.points) || !textOrEmpty(rawPathEntry.frameKey)) return null;
  const pathPoints = rawPathEntry.points.map(parsePathPoint).filter((pathPoint): pathPoint is TpwPathPoint => pathPoint !== null);
  if (!pathPoints.length) return null;
  pathPoints.sort((firstPoint, secondPoint) => firstPoint.ageMa - secondPoint.ageMa);
  const frameKey = textOrEmpty(rawPathEntry.frameKey);
  return { frameKey, frameLabel: textOrEmpty(rawPathEntry.frameLabel) || frameKey, pathPoints };
}

/**
 * Validate one polar-wander rate.
 *
 * Usage: parsePaleoMagData.
 *
 * @param rawRateEntry - Rate object from the response.
 * @returns The rate, or null when age or rate is missing.
 */
function parseRateSample(rawRateEntry: unknown): TpwRateSample | null {
  if (!isRecord(rawRateEntry)) return null;
  const sampleAgeMa = finiteOrNull(rawRateEntry.ageMa);
  const rateDegPerMyr = finiteOrNull(rawRateEntry.rateDegPerMyr);
  if (sampleAgeMa === null || rateDegPerMyr === null) return null;
  return { ageMa: sampleAgeMa, rateDegPerMyr, rateLowDegPerMyr: finiteOrNull(rawRateEntry.rateLowDegPerMyr), rateHighDegPerMyr: finiteOrNull(rawRateEntry.rateHighDegPerMyr) };
}

/**
 * Validate one net-angle sample.
 *
 * Usage: parsePaleoMagData.
 *
 * @param rawAngleEntry - Sample object from the response.
 * @returns The sample, or null without an age.
 */
function parseNetAngle(rawAngleEntry: unknown): NetAngleSample | null {
  if (!isRecord(rawAngleEntry)) return null;
  const sampleAgeMa = finiteOrNull(rawAngleEntry.ageMa);
  return sampleAgeMa === null ? null : { ageMa: sampleAgeMa, rateDegPerMyr: finiteOrNull(rawAngleEntry.rateDegPerMyr), netAngleDeg: finiteOrNull(rawAngleEntry.netAngleDeg) };
}

/**
 * Validate a list field with a per-entry parser.
 *
 * Usage: optional lists of the response.
 *
 * @param rawEntries - Field value (anything).
 * @param entryParser - Parser returning null for invalid entries.
 * @returns Valid entries ([] when the field is not a list).
 */
function parseList<EntryType>(rawEntries: unknown, entryParser: (rawEntry: unknown) => EntryType | null): EntryType[] {
  return (Array.isArray(rawEntries) ? rawEntries : []).map(entryParser).filter((parsedEntry): parsedEntry is EntryType => parsedEntry !== null);
}

/**
 * Validate the /api/paleomag body.
 *
 * Usage: fetchPaleoMagData.
 *
 * @param responseBody - Parsed JSON body.
 * @returns Poles, TPW paths, rates and net angles (invalid entries dropped).
 * @throws Error when the body is not a paleomagnetic document.
 */
export function parsePaleoMagData(responseBody: unknown): PaleoMagData {
  if (!isRecord(responseBody) || !Array.isArray(responseBody.poles)) throw new Error("invalid paleomagnetic data");
  return {
    paleoPoles: parseList(responseBody.poles, parsePole),
    tpwPaths: parseList(responseBody.tpwPaths, parsePath),
    tpwRates: parseList(responseBody.tpwRates, parseRateSample).sort((firstRate, secondRate) => firstRate.ageMa - secondRate.ageMa),
    tpwNetAngles: parseList(responseBody.tpwNetAngles, parseNetAngle).sort((firstAngle, secondAngle) => firstAngle.ageMa - secondAngle.ageMa),
  };
}
