/** Human-readable coordinate strings. */

/**
 * Format a lon/lat pair with hemisphere letters.
 *
 * Usage: selection panel.
 *
 * @param longitudeDeg - Longitude in degrees.
 * @param latitudeDeg - Latitude in degrees.
 * @returns e.g. "45.68° N, 12.35° W".
 */
export function formatLonLat(longitudeDeg: number, latitudeDeg: number): string {
  const northSouth = latitudeDeg >= 0 ? "N" : "S";
  const eastWest = longitudeDeg >= 0 ? "E" : "W";
  return `${Math.abs(latitudeDeg).toFixed(2)}° ${northSouth}, ${Math.abs(longitudeDeg).toFixed(2)}° ${eastWest}`;
}
