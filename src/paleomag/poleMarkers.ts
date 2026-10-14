/** Markers of poles: the TPW spin axis (grey rods out of the globe, path and confidence circle) and paleomagnetic north/south poles. */

import type { UnitVector } from "../plates/sphericalCoords";
import type { LabelRequest } from "../rendering/labelPlacement";
import { pointAlongArc } from "../plates/unitVectorMath";
import { smallCircle } from "./axisBasis";
import type { PlacedPole } from "./poleSelection";
import { groundPoint, spacePoint, type LineColor, type SpaceLineSet } from "./spaceLineSet";
import type { TpwFrame } from "./tpwPaths";

/** How far the spin-axis rods reach beyond the ground, in Earth radii. */
const SPIN_ROD_LENGTH = 0.55;
const SPIN_ROD_COLOR: LineColor = [0.72, 0.73, 0.76, 1];
const TRACK_COLOR: LineColor = [0.72, 0.73, 0.76, 0.6];
/** Great-circle pieces per TPW path step, so the track follows the ground. */
const TRACK_SUBDIVISIONS = 8;
export const NORTH_POLE_COLOR: LineColor = [0.95, 0.22, 0.2, 1];
export const SOUTH_POLE_COLOR: LineColor = [0.25, 0.48, 1.0, 1];
const MARKER_RADIUS_DEG = 1.2;
const MARKER_SAMPLES = 24;
const CONFIDENCE_SAMPLES = 72;
const CONFIDENCE_ALPHA = 0.55;

/**
 * Opposite direction.
 *
 * Usage: south poles of axes.
 *
 * @param inputUnit - Direction.
 * @returns −inputUnit.
 */
export function antipodeOf(inputUnit: UnitVector): UnitVector {
  return [-inputUnit[0], -inputUnit[1], -inputUnit[2]];
}

/**
 * Add a ground-level circle.
 *
 * Usage: marker rings and confidence circles.
 *
 * @param spaceLineSet - Output.
 * @param centerUnit - Centre.
 * @param radiusDeg - Angular radius.
 * @param sampleCount - Vertices.
 * @param lineColor - Colour.
 * @returns Nothing.
 */
function addGroundCircle(spaceLineSet: SpaceLineSet, centerUnit: UnitVector, radiusDeg: number, sampleCount: number, lineColor: LineColor): void {
  spaceLineSet.addPolyline(smallCircle(centerUnit, radiusDeg, sampleCount).map(groundPoint), lineColor);
}

/**
 * Add the spin-axis rods: grey lines from both poles of the TPW spin axis out into space.
 *
 * Usage: "TPW poles" layer.
 *
 * @param spaceLineSet - Output (drawn without lift).
 * @param tpwFrame - Spin axis of the chosen path at the displayed age.
 * @param labelRequests - Labels (mutated): one at each rod tip.
 * @returns Nothing.
 */
export function addSpinAxisRods(spaceLineSet: SpaceLineSet, tpwFrame: TpwFrame, labelRequests: LabelRequest[]): void {
  for (const [rodDirection, rodLabelText] of [
    [tpwFrame.spinAxisUnit, `TPW spin axis N · ${tpwFrame.frameLabel}`],
    [antipodeOf(tpwFrame.spinAxisUnit), "TPW spin axis S"],
  ] as const) {
    spaceLineSet.addSegment(groundPoint(rodDirection), spacePoint(rodDirection, 1 + SPIN_ROD_LENGTH), SPIN_ROD_COLOR);
    labelRequests.push({ labelText: rodLabelText, labelUnit: rodDirection, labelStyle: "spinAxis", labelLift: 1 + SPIN_ROD_LENGTH });
  }
}

/**
 * Add the TPW path on the ground (both hemispheres) and the pole's 95 % confidence circle.
 *
 * Usage: "TPW poles" layer.
 *
 * @param spaceLineSet - Output (ground level).
 * @param tpwFrame - Spin axis of the chosen path at the displayed age.
 * @returns Nothing.
 */
export function addTpwTrack(spaceLineSet: SpaceLineSet, tpwFrame: TpwFrame): void {
  for (const hemisphereSign of [1, -1]) {
    const trackUnits = tpwFrame.pathUnits.map((pathUnit): UnitVector => [pathUnit[0] * hemisphereSign, pathUnit[1] * hemisphereSign, pathUnit[2] * hemisphereSign]);
    const densePoints = trackUnits.flatMap((trackUnit, trackIdx) => {
      if (trackIdx === 0) return [groundPoint(trackUnit)];
      return Array.from({ length: TRACK_SUBDIVISIONS }, (_, stepIndex) => groundPoint(pointAlongArc(trackUnits[trackIdx - 1], trackUnit, (stepIndex + 1) / TRACK_SUBDIVISIONS)));
    });
    spaceLineSet.addPolyline(densePoints, TRACK_COLOR);
    const poleUnit = hemisphereSign > 0 ? tpwFrame.spinAxisUnit : antipodeOf(tpwFrame.spinAxisUnit);
    addGroundCircle(spaceLineSet, poleUnit, MARKER_RADIUS_DEG, MARKER_SAMPLES, SPIN_ROD_COLOR);
    if (tpwFrame.confidenceDeg) addGroundCircle(spaceLineSet, poleUnit, tpwFrame.confidenceDeg, CONFIDENCE_SAMPLES, TRACK_COLOR);
  }
}

/**
 * Add a marker (ring and cross) with its 95 % confidence circle.
 *
 * Usage: addMagneticPoles, per pole end.
 *
 * @param spaceLineSet - Output (ground level).
 * @param centerUnit - Pole position.
 * @param confidenceDeg - Confidence radius, or null.
 * @param markerColor - Colour.
 * @returns Nothing.
 */
function addPoleMarker(spaceLineSet: SpaceLineSet, centerUnit: UnitVector, confidenceDeg: number | null, markerColor: LineColor): void {
  const ringUnits = smallCircle(centerUnit, MARKER_RADIUS_DEG, MARKER_SAMPLES);
  spaceLineSet.addPolyline(ringUnits.map(groundPoint), markerColor);
  const quarterStep = MARKER_SAMPLES / 4;
  spaceLineSet.addSegment(groundPoint(ringUnits[0]), groundPoint(ringUnits[2 * quarterStep]), markerColor);
  spaceLineSet.addSegment(groundPoint(ringUnits[quarterStep]), groundPoint(ringUnits[3 * quarterStep]), markerColor);
  if (confidenceDeg !== null) {
    addGroundCircle(spaceLineSet, centerUnit, confidenceDeg, CONFIDENCE_SAMPLES, [markerColor[0], markerColor[1], markerColor[2], CONFIDENCE_ALPHA]);
  }
}

/**
 * Add north (red) and south (blue) paleomagnetic pole markers with their labels.
 *
 * Usage: "Magnetic poles" layer. The south pole is the antipode of the tabulated pole.
 *
 * @param spaceLineSet - Output (ground level).
 * @param placedPoles - Poles of the displayed age.
 * @param labelRequests - Labels (mutated).
 * @returns Nothing.
 */
export function addMagneticPoles(spaceLineSet: SpaceLineSet, placedPoles: PlacedPole[], labelRequests: LabelRequest[]): void {
  for (const { paleoPole, northUnit } of placedPoles) {
    const southUnit = antipodeOf(northUnit);
    addPoleMarker(spaceLineSet, northUnit, paleoPole.confidenceDeg, NORTH_POLE_COLOR);
    addPoleMarker(spaceLineSet, southUnit, paleoPole.confidenceDeg, SOUTH_POLE_COLOR);
    const poleTitle = `${paleoPole.poleName} · ${paleoPole.block}`;
    labelRequests.push({ labelText: `N ${poleTitle}`, labelUnit: northUnit, labelStyle: "magneticNorth" });
    labelRequests.push({ labelText: `S ${poleTitle}`, labelUnit: southUnit, labelStyle: "magneticSouth" });
  }
}
