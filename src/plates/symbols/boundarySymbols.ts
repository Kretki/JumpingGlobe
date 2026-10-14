/**
 * Geological map symbols of plate boundaries:
 *  - subduction zones: line with filled triangles ("teeth") on the overriding plate's side;
 *  - divergent boundaries (mid-ocean ridges, rifts): line with arrows on both sides
 *    pointing away from it along the relative spreading direction;
 *  - transforms: line with a pair of opposite arrows showing the sense of slip;
 *  - other boundaries: plain line.
 * Sizes are given in units of the symbol scale (radians), which follows the camera height.
 */

import type { BoundarySegment } from "../topology/boundaryMerging";
import { boundaryClass, type BoundaryClass } from "../topology/boundaryKinematics";
import type { UnitVector } from "../sphericalCoords";
import { leftTangent, moveAlong, normalizeOrNull, dotProduct } from "../unitVectorMath";
import { sampleStations, type LineStation } from "./polylineSampler";
import { SymbolGeometry } from "./symbolGeometry";

/** Where a point on a plate moves over a time span at the displayed age (see movedPoint). */
export type PlateMover = (plateNumber: number, pointUnit: UnitVector, timeSpanMyr: number) => UnitVector | null;

/** Geometry per boundary class, drawn in that class's colour. */
export type BoundaryGeometry = Record<BoundaryClass, SymbolGeometry>;

const TOOTH_SPACING = 2.6;
const TOOTH_WIDTH = 0.9;
const TOOTH_HEIGHT = 0.8;
const ARROW_SPACING = 6;
const ARROW_GAP = 0.35;
const ARROW_LENGTH = 1.3;
const ARROW_HEAD = 0.45;
const SLIP_SPACING = 8;
const SLIP_LENGTH = 1.1;
const MOTION_SPAN_MYR = 1;
const MIN_RELATIVE_MOTION = 1e-7;

/**
 * Empty geometry for every boundary class.
 *
 * Usage: start of a build.
 *
 * @returns One SymbolGeometry per class.
 */
export function emptyBoundaryGeometry(): BoundaryGeometry {
  return { subduction: new SymbolGeometry(), divergent: new SymbolGeometry(), transform: new SymbolGeometry(), other: new SymbolGeometry() };
}

/**
 * Tangent direction of one plate's motion relative to another at a point.
 *
 * Usage: spreading and slip arrows.
 *
 * @param plateMover - Plate motion at the displayed age.
 * @param movingPlate - Plate whose motion is measured.
 * @param referencePlate - Plate it is measured against.
 * @param pointUnit - Where.
 * @returns Unit tangent of the relative motion, or null when it is unknown or ≈ 0.
 */
export function relativeMotion(plateMover: PlateMover, movingPlate: number, referencePlate: number, pointUnit: UnitVector): UnitVector | null {
  const movingUnit = plateMover(movingPlate, pointUnit, MOTION_SPAN_MYR);
  const referenceUnit = plateMover(referencePlate, pointUnit, MOTION_SPAN_MYR);
  if (!movingUnit || !referenceUnit) return null;
  const relativeVec = [movingUnit[0] - referenceUnit[0], movingUnit[1] - referenceUnit[1], movingUnit[2] - referenceUnit[2]];
  const radialPart = dotProduct(relativeVec, pointUnit);
  const tangentVec = [relativeVec[0] - pointUnit[0] * radialPart, relativeVec[1] - pointUnit[1] * radialPart, relativeVec[2] - pointUnit[2] * radialPart];
  if (Math.hypot(tangentVec[0], tangentVec[1], tangentVec[2]) < MIN_RELATIVE_MOTION) return null;
  return normalizeOrNull(tangentVec);
}

/**
 * Plates on the two sides of a stretch.
 *
 * Usage: spreading and slip arrows.
 *
 * @param boundarySegment - Boundary stretch.
 * @returns [left plate, right plate]; resolved plates win over the feature's own left/right attributes.
 */
function sidePlates(boundarySegment: BoundarySegment): [number | null, number | null] {
  const sectionFeature = boundarySegment.sectionFeature;
  return [boundarySegment.leftPlates[0] ?? sectionFeature.leftPlate, boundarySegment.rightPlates[0] ?? sectionFeature.rightPlate];
}

/**
 * Teeth of a subduction zone.
 *
 * Usage: subduction stretches with known polarity.
 *
 * @param lineUnits - Trench line (feature direction).
 * @param overridingOnLeft - Polarity: the overriding plate is on the left of the line.
 * @param symbolScale - Symbol scale (radians).
 * @param symbolGeometry - Target geometry.
 * @returns Nothing.
 */
function addTeeth(lineUnits: UnitVector[], overridingOnLeft: boolean, symbolScale: number, symbolGeometry: SymbolGeometry): void {
  for (const { pointUnit, tangentUnit } of sampleStations(lineUnits, TOOTH_SPACING * symbolScale)) {
    const sideUnit = leftTangent(pointUnit, tangentUnit);
    const halfWidth = (TOOTH_WIDTH * symbolScale) / 2;
    symbolGeometry.addTriangle(
      moveAlong(pointUnit, tangentUnit, -halfWidth),
      moveAlong(pointUnit, tangentUnit, halfWidth),
      moveAlong(pointUnit, sideUnit, (overridingOnLeft ? 1 : -1) * TOOTH_HEIGHT * symbolScale)
    );
  }
}

/**
 * Pair of arrows at a station: one on each side of the line, pointing in opposite directions.
 *
 * Usage: spreading arrows (away from the line) and slip arrows (along it).
 *
 * @param lineStation - Station on the line.
 * @param rightDirection - Arrow direction on the right side (the left arrow points the other way).
 * @param shaftRad - Arrow length.
 * @param symbolScale - Symbol scale (radians).
 * @param symbolGeometry - Target geometry.
 * @returns Nothing.
 */
function addArrowPair(lineStation: LineStation, rightDirection: UnitVector, shaftRad: number, symbolScale: number, symbolGeometry: SymbolGeometry): void {
  const sideUnit = leftTangent(lineStation.pointUnit, lineStation.tangentUnit);
  for (const sideSign of [-1, 1]) {
    const baseUnit = moveAlong(lineStation.pointUnit, sideUnit, sideSign * ARROW_GAP * symbolScale);
    const arrowDirection: UnitVector = [rightDirection[0] * -sideSign, rightDirection[1] * -sideSign, rightDirection[2] * -sideSign];
    symbolGeometry.addArrow(baseUnit, arrowDirection, shaftRad, ARROW_HEAD * symbolScale);
  }
}

/**
 * Spreading arrows of a divergent stretch.
 *
 * Usage: ridges and rifts. Each arrow shows how its side moves relative to the other
 * side; without plate motion they point straight away from the line.
 *
 * @param boundarySegment - Divergent stretch.
 * @param plateMover - Plate motion at the displayed age.
 * @param symbolScale - Symbol scale (radians).
 * @param symbolGeometry - Target geometry.
 * @returns Nothing.
 */
function addSpreadingArrows(boundarySegment: BoundarySegment, plateMover: PlateMover, symbolScale: number, symbolGeometry: SymbolGeometry): void {
  const [leftPlate, rightPlate] = sidePlates(boundarySegment);
  for (const lineStation of sampleStations(boundarySegment.lineUnits, ARROW_SPACING * symbolScale)) {
    const awayRight = leftTangent(lineStation.pointUnit, lineStation.tangentUnit).map((component) => -component) as UnitVector;
    const measuredRight = leftPlate !== null && rightPlate !== null ? relativeMotion(plateMover, rightPlate, leftPlate, lineStation.pointUnit) : null;
    addArrowPair(lineStation, measuredRight ?? awayRight, ARROW_LENGTH * symbolScale, symbolScale, symbolGeometry);
  }
}

/**
 * Slip arrows of a transform stretch (shown only where the relative motion is known).
 *
 * Usage: transforms. The arrow on each side points the way that side moves along the fault.
 *
 * @param boundarySegment - Transform stretch.
 * @param plateMover - Plate motion at the displayed age.
 * @param symbolScale - Symbol scale (radians).
 * @param symbolGeometry - Target geometry.
 * @returns Nothing.
 */
function addSlipArrows(boundarySegment: BoundarySegment, plateMover: PlateMover, symbolScale: number, symbolGeometry: SymbolGeometry): void {
  const [leftPlate, rightPlate] = sidePlates(boundarySegment);
  if (leftPlate === null || rightPlate === null) return;
  for (const lineStation of sampleStations(boundarySegment.lineUnits, SLIP_SPACING * symbolScale)) {
    const rightMotion = relativeMotion(plateMover, rightPlate, leftPlate, lineStation.pointUnit);
    if (!rightMotion) continue;
    // Slip is along the fault: keep only the along-strike sense.
    const slipSign = dotProduct(rightMotion, lineStation.tangentUnit) >= 0 ? 1 : -1;
    const slipDirection = lineStation.tangentUnit.map((component) => component * slipSign) as UnitVector;
    addArrowPair(lineStation, slipDirection, SLIP_LENGTH * symbolScale, symbolScale, symbolGeometry);
  }
}

/**
 * Add one boundary stretch with its symbol.
 *
 * Usage: per resolved boundary stretch.
 *
 * @param boundarySegment - Stretch.
 * @param plateMover - Plate motion at the displayed age.
 * @param symbolScale - Symbol scale (radians).
 * @param boundaryGeometry - Target geometry per class.
 * @returns Nothing.
 */
export function addBoundarySymbols(
  boundarySegment: BoundarySegment,
  plateMover: PlateMover,
  symbolScale: number,
  boundaryGeometry: BoundaryGeometry
): void {
  const segmentClass = boundaryClass(boundarySegment.sectionFeature);
  const symbolGeometry = boundaryGeometry[segmentClass];
  symbolGeometry.addPolyline(boundarySegment.lineUnits);
  const polarity = boundarySegment.sectionFeature.polarity;
  if (segmentClass === "subduction" && polarity) addTeeth(boundarySegment.lineUnits, polarity === "Left", symbolScale, symbolGeometry);
  else if (segmentClass === "divergent") addSpreadingArrows(boundarySegment, plateMover, symbolScale, symbolGeometry);
  else if (segmentClass === "transform") addSlipArrows(boundarySegment, plateMover, symbolScale, symbolGeometry);
}
