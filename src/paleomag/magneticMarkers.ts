/**
 * Markers of the geomagnetic poles of the displayed age (poleClusters.ts) and of the
 * individual site VGPs they are made of. Each pole is drawn at its north end (red) and its
 * antipode (blue); the marker grows with the pole's dipole moment and a fainter circle shows
 * how widely its VGPs scatter.
 */

import type { UnitVector } from "../plates/sphericalCoords";
import type { LabelRequest } from "../rendering/labelPlacement";
import { smallCircle } from "./axisBasis";
import type { SitePolarity } from "./pintSites";
import { DEFAULT_MOMENT_E22, type MagneticPole } from "./poleClusters";
import { addGroundCircle, antipodeOf, MARKER_SAMPLES, NORTH_POLE_COLOR, SOUTH_POLE_COLOR } from "./poleMarkers";
import { groundPoint, type LineColor, type SpaceLineSet } from "./spaceLineSet";
import type { WindowSite } from "./siteWindow";

/** Marker radius (degrees) of a pole with the present-day moment; scales with √moment. */
const BASE_MARKER_DEG = 1.6;
const MAX_MARKER_DEG = 4;
const SPREAD_SAMPLES = 60;
const SPREAD_ALPHA = 0.45;
/** Half-length (degrees) of a site VGP tick. */
const SITE_TICK_DEG = 0.45;
const SITE_COLORS: Record<SitePolarity, LineColor> = {
  N: [1.0, 0.45, 0.4, 1],
  R: [0.45, 0.65, 1.0, 1],
  T: [1.0, 0.85, 0.3, 1],
  U: [0.75, 0.75, 0.8, 1],
};

/**
 * Text of a dipole moment.
 *
 * Usage: pole labels and notes.
 *
 * @param momentE22 - Moment in 10²² A·m².
 * @returns e.g. "7.9×10²² A·m²".
 */
export function momentText(momentE22: number): string {
  return `${momentE22.toFixed(1)}×10²² A·m²`;
}

/**
 * Ring with a cross.
 *
 * Usage: addMagneticPoles, per pole end.
 *
 * @param spaceLineSet - Output (ground level).
 * @param centerUnit - Pole position.
 * @param radiusDeg - Ring radius.
 * @param markerColor - Colour.
 * @returns Nothing.
 */
function addRingMarker(spaceLineSet: SpaceLineSet, centerUnit: UnitVector, radiusDeg: number, markerColor: LineColor): void {
  const ringUnits = smallCircle(centerUnit, radiusDeg, MARKER_SAMPLES);
  spaceLineSet.addPolyline(ringUnits.map(groundPoint), markerColor);
  const quarterStep = MARKER_SAMPLES / 4;
  spaceLineSet.addSegment(groundPoint(ringUnits[0]), groundPoint(ringUnits[2 * quarterStep]), markerColor);
  spaceLineSet.addSegment(groundPoint(ringUnits[quarterStep]), groundPoint(ringUnits[3 * quarterStep]), markerColor);
}

/**
 * Add the pole markers and their labels.
 *
 * Usage: "Magnetic poles" layer.
 *
 * @param spaceLineSet - Output (ground level).
 * @param magneticPoles - Poles of the displayed age, strongest first.
 * @param labelRequests - Labels (mutated): ``N1 · 7.9×10²² A·m² · 12 sites`` and ``S1``.
 * @returns Nothing.
 */
export function addMagneticPoles(spaceLineSet: SpaceLineSet, magneticPoles: MagneticPole[], labelRequests: LabelRequest[]): void {
  magneticPoles.forEach((magneticPole, poleIndex) => {
    const markerDeg = Math.min(MAX_MARKER_DEG, BASE_MARKER_DEG * Math.sqrt(magneticPole.momentE22 / DEFAULT_MOMENT_E22));
    const southUnit = antipodeOf(magneticPole.northUnit);
    for (const [poleUnit, poleColor] of [
      [magneticPole.northUnit, NORTH_POLE_COLOR],
      [southUnit, SOUTH_POLE_COLOR],
    ] as const) {
      addRingMarker(spaceLineSet, poleUnit, markerDeg, poleColor);
      if (magneticPole.spreadDeg > markerDeg) {
        addGroundCircle(spaceLineSet, poleUnit, magneticPole.spreadDeg, SPREAD_SAMPLES, [poleColor[0], poleColor[1], poleColor[2], SPREAD_ALPHA]);
      }
    }
    const strengthText = `${momentText(magneticPole.momentE22)}${magneticPole.momentMeasured ? "" : " (est.)"}`;
    const siteText = `${magneticPole.siteCount} site${magneticPole.siteCount === 1 ? "" : "s"}`;
    labelRequests.push({ labelText: `N${poleIndex + 1} · ${strengthText} · ${siteText}`, labelUnit: magneticPole.northUnit, labelStyle: "magneticNorth" });
    labelRequests.push({ labelText: `S${poleIndex + 1}`, labelUnit: southUnit, labelStyle: "magneticSouth" });
  });
}

/**
 * Add a short tick at every site VGP of the window, coloured by polarity and faded with age distance.
 *
 * Usage: "Magnetic poles" layer (shows the scatter behind each pole).
 *
 * @param spaceLineSet - Output (ground level).
 * @param windowSites - Sites of the window.
 * @returns Nothing.
 */
export function addSiteVgps(spaceLineSet: SpaceLineSet, windowSites: WindowSite[]): void {
  for (const windowSite of windowSites) {
    if (!windowSite.vgpUnit) continue;
    const baseColor = SITE_COLORS[windowSite.polarity];
    const tickColor: LineColor = [baseColor[0], baseColor[1], baseColor[2], 0.25 + 0.75 * windowSite.ageCloseness];
    const tickUnits = smallCircle(windowSite.vgpUnit, SITE_TICK_DEG, 4);
    spaceLineSet.addSegment(groundPoint(tickUnits[0]), groundPoint(tickUnits[2]), tickColor);
    spaceLineSet.addSegment(groundPoint(tickUnits[1]), groundPoint(tickUnits[3]), tickColor);
  }
}
