/**
 * Magnetic field lines of the displayed age, traced through the combined field of every
 * magnetic source (fieldSources.ts). Lines start in a tube around each geomagnetic south
 * pole (where the field leaves the ground), shared out by source strength, and follow the
 * field to wherever it returns: usually the source's own north pole, but with several
 * sources also another one. They shade from blue (leaving) to red (entering) and carry an
 * arrow along the field at their highest point. Tube mouths are outlined on the ground and
 * every source's axis sticks out of both poles.
 */

import { WGS84_SEMI_MAJOR } from "../geodesy/wgs84Ellipsoid";
import type { UnitVector } from "../plates/sphericalCoords";
import { basisAround, directionAround, smallCircle } from "./axisBasis";
import type { MagneticCharge } from "./fieldSources";
import { resampleLine, traceFieldLine } from "./fieldTracer";
import { NORTH_POLE_COLOR, SOUTH_POLE_COLOR } from "./poleMarkers";
import { blendColors, groundPoint, spacePoint, type LineColor, type SpacePoint, type SpaceLineSet } from "./spaceLineSet";

/** Angular radius (degrees) of the tube a layer's lines start from: layer 1 is lowest. */
export const SEED_COLATITUDES_DEG = [30, 18, 12];
export const LINES_PER_LAYER = 24;
/** Segments per drawn field line. */
export const SAMPLES_PER_LINE = 96;
const ARROW_HEAD_FRACTION = 0.06;
const AXIS_REACH = 1.35;
const TUBE_RING_SAMPLES = 48;
const OPEN_LINE_COLOR: LineColor = [0.7, 0.55, 0.85, 0.7];

/**
 * Line counts per positive charge for one layer (proportional to strength, at least one).
 *
 * Usage: addFieldLines.
 *
 * @param sourceCharges - Positive charges.
 * @returns Count per charge.
 */
export function linesPerSource(sourceCharges: MagneticCharge[]): number[] {
  const totalStrength = sourceCharges.reduce((strengthSum, sourceCharge) => strengthSum + sourceCharge.chargeStrength, 0);
  return sourceCharges.map((sourceCharge) => Math.max(1, Math.round((LINES_PER_LAYER * sourceCharge.chargeStrength) / (totalStrength || 1))));
}

/**
 * Arrow head at the highest point of a line, pointing along the field.
 *
 * Usage: addTracedLine.
 *
 * @param spaceLineSet - Output.
 * @param linePoints - Line in ECEF metres.
 * @param arrowColor - Colour.
 * @returns Nothing.
 */
function addApexArrow(spaceLineSet: SpaceLineSet, linePoints: SpacePoint[], arrowColor: LineColor): void {
  let apexIndex = 1;
  for (let pointIdx = 1; pointIdx < linePoints.length - 1; pointIdx++) {
    if (Math.hypot(...linePoints[pointIdx]) > Math.hypot(...linePoints[apexIndex])) apexIndex = pointIdx;
  }
  const apexPoint = linePoints[apexIndex];
  const travelVector = [0, 1, 2].map((axisIndex) => linePoints[apexIndex + 1][axisIndex] - linePoints[apexIndex - 1][axisIndex]);
  const travelLength = Math.hypot(...travelVector) || 1;
  const apexRadius = Math.hypot(...apexPoint) || 1;
  const headLength = ARROW_HEAD_FRACTION * apexRadius;
  for (const sideSign of [1, -1]) {
    const headEndPoint = [0, 1, 2].map(
      (axisIndex) => apexPoint[axisIndex] + headLength * (-0.866 * (travelVector[axisIndex] / travelLength) + 0.5 * sideSign * (apexPoint[axisIndex] / apexRadius))
    ) as SpacePoint;
    spaceLineSet.addSegment(apexPoint, headEndPoint, arrowColor);
  }
}

/**
 * Trace and add one line from a seed.
 *
 * Usage: addFieldLines.
 *
 * @param spaceLineSet - Output.
 * @param fieldCharges - All charges.
 * @param seedUnit - Ground seed.
 * @returns True when a line was added.
 */
function addTracedLine(spaceLineSet: SpaceLineSet, fieldCharges: MagneticCharge[], seedUnit: UnitVector): boolean {
  const tracedLine = traceFieldLine(fieldCharges, seedUnit);
  if (!tracedLine || tracedLine.linePoints.length < 3) return false;
  const linePoints = resampleLine(tracedLine.linePoints, SAMPLES_PER_LINE).map(
    (linePoint): SpacePoint => [linePoint[0] * WGS84_SEMI_MAJOR, linePoint[1] * WGS84_SEMI_MAJOR, linePoint[2] * WGS84_SEMI_MAJOR]
  );
  const endColor = tracedLine.returnsToGround ? NORTH_POLE_COLOR : OPEN_LINE_COLOR;
  const lineColors = linePoints.map((_, pointIdx) => blendColors(SOUTH_POLE_COLOR, endColor, pointIdx / (linePoints.length - 1)));
  spaceLineSet.addPolyline(linePoints, lineColors);
  addApexArrow(spaceLineSet, linePoints, lineColors[Math.floor(lineColors.length / 2)]);
  return true;
}

/**
 * Outline a tube mouth on the ground.
 *
 * Usage: addFieldLines, per charge and layer.
 *
 * @param spaceLineSet - Output.
 * @param fieldCharge - Charge whose ground point is the tube's centre.
 * @param seedColatitudeDeg - Tube radius.
 * @returns Nothing.
 */
function addTubeMouth(spaceLineSet: SpaceLineSet, fieldCharge: MagneticCharge, seedColatitudeDeg: number): void {
  const ringColor = fieldCharge.chargeStrength > 0 ? SOUTH_POLE_COLOR : NORTH_POLE_COLOR;
  spaceLineSet.addPolyline(smallCircle(fieldCharge.groundUnit, seedColatitudeDeg, TUBE_RING_SAMPLES).map(groundPoint), ringColor);
}

/**
 * Add the field lines of 1–3 layers, their tube mouths and the source axes.
 *
 * Usage: "Magnetic field lines" layer.
 *
 * @param spaceLineSet - Output (drawn without lift).
 * @param fieldCharges - Charges of the displayed age (fieldSources.buildFieldCharges).
 * @param layerCount - Number of layers, clamped to 1..3 (outer layers start nearer the poles and reach further).
 * @returns Number of lines drawn.
 */
export function addFieldLines(spaceLineSet: SpaceLineSet, fieldCharges: MagneticCharge[], layerCount: number): number {
  const sourceCharges = fieldCharges.filter((fieldCharge) => fieldCharge.chargeStrength > 0);
  const lineCounts = linesPerSource(sourceCharges);
  const seedColatitudes = SEED_COLATITUDES_DEG.slice(0, Math.min(SEED_COLATITUDES_DEG.length, Math.max(1, Math.round(layerCount))));
  let drawnLines = 0;
  for (const seedColatitudeDeg of seedColatitudes) {
    sourceCharges.forEach((sourceCharge, sourceIndex) => {
      const axisBasis = basisAround(sourceCharge.groundUnit);
      for (let lineIndex = 0; lineIndex < lineCounts[sourceIndex]; lineIndex++) {
        const seedUnit = directionAround(axisBasis, (seedColatitudeDeg * Math.PI) / 180, (2 * Math.PI * (lineIndex + 0.5)) / lineCounts[sourceIndex]);
        if (addTracedLine(spaceLineSet, fieldCharges, seedUnit)) drawnLines++;
      }
    });
    for (const fieldCharge of fieldCharges) addTubeMouth(spaceLineSet, fieldCharge, seedColatitudeDeg);
  }
  for (const fieldCharge of fieldCharges) {
    const axisColor = fieldCharge.chargeStrength > 0 ? SOUTH_POLE_COLOR : NORTH_POLE_COLOR;
    spaceLineSet.addSegment(groundPoint(fieldCharge.groundUnit), spacePoint(fieldCharge.groundUnit, AXIS_REACH), axisColor);
  }
  return drawnLines;
}
