/**
 * Magnetic field lines drawn like those of a bar magnet (see magnetProfile.ts): each
 * line leaves the ground in a tube around the north magnetic pole and returns in a tube
 * around the south pole, shading from red to blue, with an arrow at its apex. The tube
 * mouths are outlined on the ground and the magnet's axis runs through both poles.
 */

import { WGS84_SEMI_MAJOR } from "../geodesy/wgs84Ellipsoid";
import type { UnitVector } from "../plates/sphericalCoords";
import type { LabelRequest } from "../rendering/labelPlacement";
import { basisAround, directionAround, smallCircle, type AxisBasis } from "./axisBasis";
import { profileForApex, type ProfilePoint } from "./magnetProfile";
import { antipodeOf, NORTH_POLE_COLOR, SOUTH_POLE_COLOR } from "./poleMarkers";
import { blendColors, groundPoint, spacePoint, type LineColor, type SpacePoint, type SpaceLineSet } from "./spaceLineSet";

/** Apex distance (Earth radii) of the field lines of layer 1, 2 and 3. */
export const FIELD_SHELL_RADII = [1.6, 2.4, 3.4];
export const LINES_PER_SHELL = 24;
/** Segments per field line (even, so the middle sample is the apex). */
export const SAMPLES_PER_LINE = 96;
/** Arrow-head stroke length as a fraction of the shell radius. */
const ARROW_HEAD_FRACTION = 0.07;
const AXIS_OVERHANG = 0.45;
const TUBE_RING_SAMPLES = 48;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * 3-D point of a meridian-plane profile point at an azimuth around the magnet axis.
 *
 * Usage: place the profile of a layer at each of its 24 azimuths.
 *
 * @param axisBasis - Magnet basis (axis = north magnetic pole).
 * @param profilePoint - [axial offset, height] in Earth radii.
 * @param azimuthRad - Azimuth around the axis.
 * @returns ECEF metres.
 */
function profileToSpace(axisBasis: AxisBasis, profilePoint: ProfilePoint, azimuthRad: number): SpacePoint {
  const [axialOffset, axialHeight] = profilePoint;
  const offsetUnit = directionAround(axisBasis, Math.PI / 2, azimuthRad);
  return [0, 1, 2].map(
    (axisIndex) => WGS84_SEMI_MAJOR * (axialOffset * offsetUnit[axisIndex] + axialHeight * axisBasis.axisUnit[axisIndex])
  ) as SpacePoint;
}

/**
 * Add one field line with its apex arrow (pointing from north to south).
 *
 * Usage: addFieldLines.
 *
 * @param spaceLineSet - Output.
 * @param axisBasis - Magnet basis.
 * @param profilePoints - Profile of the layer (SAMPLES_PER_LINE + 1 points).
 * @param azimuthRad - Azimuth of this line.
 * @returns Nothing.
 */
function addFieldLine(spaceLineSet: SpaceLineSet, axisBasis: AxisBasis, profilePoints: ProfilePoint[], azimuthRad: number): void {
  const linePoints = profilePoints.map((profilePoint) => profileToSpace(axisBasis, profilePoint, azimuthRad));
  const lineColors: LineColor[] = linePoints.map((_, pointIdx) => blendColors(NORTH_POLE_COLOR, SOUTH_POLE_COLOR, pointIdx / (linePoints.length - 1)));
  spaceLineSet.addPolyline(linePoints, lineColors);
  const apexIndex = Math.floor(linePoints.length / 2);
  const apexPoint = linePoints[apexIndex];
  const travelVector = [0, 1, 2].map((axisIndex) => linePoints[apexIndex + 1][axisIndex] - linePoints[apexIndex - 1][axisIndex]);
  const travelLength = Math.hypot(...travelVector) || 1;
  const radialUnit = directionAround(axisBasis, Math.PI / 2, azimuthRad);
  const headLength = ARROW_HEAD_FRACTION * Math.hypot(...apexPoint);
  for (const sideSign of [1, -1]) {
    const headEndPoint = [0, 1, 2].map(
      (axisIndex) => apexPoint[axisIndex] + headLength * (-0.866 * (travelVector[axisIndex] / travelLength) + 0.5 * sideSign * radialUnit[axisIndex])
    ) as SpacePoint;
    spaceLineSet.addSegment(apexPoint, headEndPoint, lineColors[apexIndex]);
  }
}

/**
 * Outline where a layer's tube meets the ground around both magnetic poles.
 *
 * Usage: addFieldLines, per layer.
 *
 * @param spaceLineSet - Output.
 * @param northAxisUnit - North magnetic pole.
 * @param footColatitudeRad - Angular radius of the tube mouth.
 * @returns Nothing.
 */
function addTubeMouths(spaceLineSet: SpaceLineSet, northAxisUnit: UnitVector, footColatitudeRad: number): void {
  for (const [poleUnit, ringColor] of [
    [northAxisUnit, NORTH_POLE_COLOR],
    [antipodeOf(northAxisUnit), SOUTH_POLE_COLOR],
  ] as const) {
    spaceLineSet.addPolyline(smallCircle(poleUnit, footColatitudeRad * RAD_TO_DEG, TUBE_RING_SAMPLES).map(groundPoint), ringColor);
  }
}

/**
 * Add the field lines of 1–3 shells (24 lines each), their tube mouths and the magnet axis.
 *
 * Usage: "Magnetic field lines" layer.
 *
 * @param spaceLineSet - Output (drawn without lift).
 * @param northAxisUnit - North magnetic pole direction (mean of the displayed poles).
 * @param shellCount - Number of shells, clamped to 1..3 (outer shells are further from the ground).
 * @param labelRequests - Labels (mutated): one at each end of the dipole axis.
 * @returns Nothing.
 */
export function addFieldLines(spaceLineSet: SpaceLineSet, northAxisUnit: UnitVector, shellCount: number, labelRequests: LabelRequest[]): void {
  const axisBasis = basisAround(northAxisUnit);
  const shellRadii = FIELD_SHELL_RADII.slice(0, Math.min(FIELD_SHELL_RADII.length, Math.max(1, Math.round(shellCount))));
  for (const shellRadius of shellRadii) {
    const fieldProfile = profileForApex(shellRadius, SAMPLES_PER_LINE);
    for (let lineIndex = 0; lineIndex < LINES_PER_SHELL; lineIndex++) {
      addFieldLine(spaceLineSet, axisBasis, fieldProfile.profilePoints, (2 * Math.PI * lineIndex) / LINES_PER_SHELL);
    }
    addTubeMouths(spaceLineSet, northAxisUnit, fieldProfile.footColatitudeRad);
  }
  const axisReach = shellRadii[shellRadii.length - 1] + AXIS_OVERHANG;
  const southAxisUnit = antipodeOf(northAxisUnit);
  spaceLineSet.addSegment(groundPoint(northAxisUnit), spacePoint(northAxisUnit, axisReach), NORTH_POLE_COLOR);
  spaceLineSet.addSegment(groundPoint(southAxisUnit), spacePoint(southAxisUnit, axisReach), SOUTH_POLE_COLOR);
  labelRequests.push({ labelText: "Dipole N", labelUnit: northAxisUnit, labelStyle: "magneticNorth", labelLift: axisReach });
  labelRequests.push({ labelText: "Dipole S", labelUnit: southAxisUnit, labelStyle: "magneticSouth", labelLift: axisReach });
}
