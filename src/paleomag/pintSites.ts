/** PINT paleointensity sites of /api/paleomag, validated into typed arrays (one entry per site). */

/** Polarity letters: N normal, R reversed, T transitional, U unknown. */
export type SitePolarity = "N" | "R" | "T" | "U";

/**
 * Sites in column form. Missing values are NaN (numbers) or -1 (plate).
 * VGP coordinates are the site's virtual geomagnetic pole in present-day coordinates.
 */
export type PintSites = {
  siteCount: number;
  siteNames: string[];
  siteLat: Float64Array;
  siteLon: Float64Array;
  ageMa: Float64Array;
  ageError: Float64Array;
  /** Dipole moment (VDM or VADM) in 10²² A·m². */
  momentE22: Float64Array;
  vgpLat: Float64Array;
  vgpLon: Float64Array;
  plateNumber: Int32Array;
  polarity: SitePolarity[];
};

type RawRecord = Record<string, unknown>;

const POLARITY_LETTERS: readonly SitePolarity[] = ["N", "R", "T", "U"];

/**
 * A numeric column as a typed array (non-numbers become NaN).
 *
 * Usage: parsePintSites.
 *
 * @param rawColumn - Column value from the response.
 * @param siteCount - Expected length.
 * @returns The column, or null when it is not an array of that length.
 */
function numberColumn(rawColumn: unknown, siteCount: number): Float64Array | null {
  if (!Array.isArray(rawColumn) || rawColumn.length !== siteCount) return null;
  return Float64Array.from(rawColumn, (cellValue) => (typeof cellValue === "number" && Number.isFinite(cellValue) ? cellValue : NaN));
}

/**
 * Validate the ``sites`` object of the response.
 *
 * Usage: parsePaleoMagData.
 *
 * @param rawSites - Column object (``siteName``, ``siteLat``, ``siteLon``, ``ageMa``, ``ageError``,
 *   ``momentE22``, ``vgpLat``, ``vgpLon``, ``plateId`` arrays and a ``polarity`` string).
 * @returns The sites, or null when missing or malformed.
 */
export function parsePintSites(rawSites: unknown): PintSites | null {
  if (typeof rawSites !== "object" || rawSites === null) return null;
  const siteColumns = rawSites as RawRecord;
  if (!Array.isArray(siteColumns.ageMa) || typeof siteColumns.polarity !== "string") return null;
  const siteCount = siteColumns.ageMa.length;
  if (siteColumns.polarity.length !== siteCount) return null;
  const numericColumns = ["siteLat", "siteLon", "ageMa", "ageError", "momentE22", "vgpLat", "vgpLon", "plateId"].map((columnName) =>
    numberColumn(siteColumns[columnName], siteCount)
  );
  if (numericColumns.some((numericColumn) => numericColumn === null)) return null;
  const [latColumn, lonColumn, ageColumn, errorColumn, momentColumn, vgpLatColumn, vgpLonColumn, plateColumn] = numericColumns as Float64Array[];
  const rawNames = Array.isArray(siteColumns.siteName) ? siteColumns.siteName : [];
  return {
    siteCount,
    siteNames: Array.from({ length: siteCount }, (_, siteIndex) => (typeof rawNames[siteIndex] === "string" ? (rawNames[siteIndex] as string) : "")),
    siteLat: latColumn,
    siteLon: lonColumn,
    ageMa: ageColumn,
    ageError: errorColumn.map((errorValue) => (Number.isFinite(errorValue) ? Math.abs(errorValue) : 0)),
    momentE22: momentColumn.map((momentValue) => (momentValue > 0 ? momentValue : NaN)),
    vgpLat: vgpLatColumn,
    vgpLon: vgpLonColumn,
    plateNumber: Int32Array.from(plateColumn, (plateValue) => (Number.isFinite(plateValue) ? plateValue : -1)),
    polarity: Array.from(siteColumns.polarity, (polarityLetter) => POLARITY_LETTERS.find((knownLetter) => knownLetter === polarityLetter) ?? "U"),
  };
}
