/** ICS geologic periods within the rotation model's range (Cao et al. 2024 reaches 1.8 Ga). */

/** [older bound Ma, period name], youngest first. */
const PERIOD_BOUNDS: [number, string][] = [
  [2.58, "Quaternary"],
  [23.03, "Neogene"],
  [66, "Paleogene"],
  [145, "Cretaceous"],
  [201.4, "Jurassic"],
  [251.9, "Triassic"],
  [298.9, "Permian"],
  [358.9, "Carboniferous"],
  [419.2, "Devonian"],
  [443.8, "Silurian"],
  [485.4, "Ordovician"],
  [538.8, "Cambrian"],
  [635, "Ediacaran"],
  [720, "Cryogenian"],
  [1000, "Tonian"],
  [1200, "Stenian"],
  [1400, "Ectasian"],
  [1600, "Calymmian"],
  [1800, "Statherian"],
  [2050, "Orosirian"],
];

/**
 * Name of the geologic period containing an age.
 *
 * Usage: timeline read-out.
 *
 * @param ageInMyr - Age in Ma.
 * @returns Period name, or "" beyond the table.
 */
export function periodName(ageInMyr: number): string {
  for (const [olderBound, nameOfPeriod] of PERIOD_BOUNDS) if (ageInMyr <= olderBound) return nameOfPeriod;
  return "";
}
