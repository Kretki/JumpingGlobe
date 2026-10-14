/** Kinematics of resolved plates: boundary classes, which plates subduct, and how a point on a plate moves. */

import { quatConjugate, quatMultiply, quatRotate } from "../quaternionMath";
import type { UnitVector } from "../sphericalCoords";
import { arcAngle } from "../unitVectorMath";
import type { BoundarySegment } from "./boundaryMerging";
import type { RotationLookup } from "./rotationCache";
import type { SectionFeature } from "./topologyModel";
import type { ResolvedPlate } from "./topologyResolver";

/** How a boundary piece is drawn. */
export type BoundaryClass = "subduction" | "divergent" | "transform" | "other";

const DIVERGENT_TYPES = new Set(["MidOceanRidge", "ContinentalRift"]);
const TRANSFORM_TYPES = new Set(["Transform"]);
const SUBDUCTION_TYPES = new Set(["SubductionZone"]);

/**
 * Drawing class of a section feature.
 *
 * Usage: choose the symbol of each boundary piece.
 *
 * @param sectionFeature - Feature of the boundary piece.
 * @returns ``subduction``, ``divergent`` (ridges, rifts), ``transform`` or ``other``.
 */
export function boundaryClass(sectionFeature: SectionFeature): BoundaryClass {
  if (SUBDUCTION_TYPES.has(sectionFeature.featureType)) return "subduction";
  if (DIVERGENT_TYPES.has(sectionFeature.featureType)) return "divergent";
  if (TRANSFORM_TYPES.has(sectionFeature.featureType)) return "transform";
  return "other";
}

/**
 * Plates going down at a subduction-zone stretch.
 *
 * Usage: subductingPlates.
 *
 * @param boundarySegment - Resolved boundary stretch.
 * @returns Plates on the side opposite the polarity (the polarity names the overriding side);
 *   [] for other boundaries or unknown polarity.
 */
export function subductingPlatesOf(boundarySegment: BoundarySegment): number[] {
  const polarity = boundarySegment.sectionFeature.polarity;
  if (boundaryClass(boundarySegment.sectionFeature) !== "subduction" || !polarity) return [];
  return polarity === "Left" ? boundarySegment.rightPlates : boundarySegment.leftPlates;
}

/**
 * Length of a polyline or ring on the unit sphere.
 *
 * Usage: boundary lengths and plate perimeters.
 *
 * @param lineUnits - Vertices.
 * @param isClosed - Also count the closing edge.
 * @returns Length in radians.
 */
function polylineLength(lineUnits: UnitVector[], isClosed: boolean): number {
  let totalLength = 0;
  for (let pointIdx = 1; pointIdx < lineUnits.length; pointIdx++) totalLength += arcAngle(lineUnits[pointIdx - 1], lineUnits[pointIdx]);
  if (isClosed && lineUnits.length > 2) totalLength += arcAngle(lineUnits[lineUnits.length - 1], lineUnits[0]);
  return totalLength;
}

/**
 * Plates being consumed at subduction zones at the resolved age.
 *
 * Usage: the "subducting plates" layer. A plate counts when the trenches it goes down
 * at make up at least minShare of its perimeter, which selects the oceanic plates
 * being consumed (Pacific, Nazca, Farallon, ...) rather than every continent that
 * has one short trench somewhere along its edge.
 *
 * @param boundarySegments - Resolved boundary stretches.
 * @param resolvedPlates - Resolved plate polygons (for perimeters).
 * @param minShare - Minimum downgoing share of the perimeter, 0..1.
 * @returns Plate ids.
 */
export function subductingPlates(boundarySegments: BoundarySegment[], resolvedPlates: ResolvedPlate[], minShare: number): Set<number> {
  const downgoingLength = new Map<number, number>();
  for (const boundarySegment of boundarySegments) {
    const downgoingPlates = subductingPlatesOf(boundarySegment);
    if (!downgoingPlates.length) continue;
    // A stretch bordering several downgoing plates is shared out evenly between them.
    const lengthShare = polylineLength(boundarySegment.lineUnits, false) / downgoingPlates.length;
    for (const plateNumber of downgoingPlates) downgoingLength.set(plateNumber, (downgoingLength.get(plateNumber) ?? 0) + lengthShare);
  }
  const perimeterOf = new Map<number, number>();
  for (const resolvedPlate of resolvedPlates) {
    perimeterOf.set(resolvedPlate.plateNumber, (perimeterOf.get(resolvedPlate.plateNumber) ?? 0) + polylineLength(resolvedPlate.ringUnits, true));
  }
  const plateSet = new Set<number>();
  for (const [plateNumber, trenchLength] of downgoingLength) {
    const platePerimeter = perimeterOf.get(plateNumber) ?? 0;
    if (plateNumber !== 0 && platePerimeter > 0 && trenchLength / platePerimeter >= minShare) plateSet.add(plateNumber);
  }
  return plateSet;
}

/**
 * Where a point on a plate will be after some time, moving towards the present.
 *
 * Usage: plate-motion ticks and spreading arrows.
 *
 * @param rotationLookup - Plate rotations.
 * @param plateNumber - Plate carrying the point.
 * @param ageInMyr - Displayed age (Ma).
 * @param pointUnit - Point position at that age.
 * @param timeSpanMyr - Time span (Myr, > 0).
 * @returns The future position, or null when the plate has no poles. At the present,
 *   where no future exists, the motion over the last timeSpanMyr is extrapolated.
 */
export function movedPoint(
  rotationLookup: RotationLookup,
  plateNumber: number,
  ageInMyr: number,
  pointUnit: UnitVector,
  timeSpanMyr: number
): UnitVector | null {
  const youngerAge = Math.max(0, ageInMyr - timeSpanMyr);
  const isExtrapolated = youngerAge === ageInMyr;
  const otherAge = isExtrapolated ? ageInMyr + timeSpanMyr : youngerAge;
  const currentRotation = rotationLookup.rotationAt(plateNumber, ageInMyr);
  const otherRotation = rotationLookup.rotationAt(plateNumber, otherAge);
  if (!currentRotation || !otherRotation) return null;
  // Position at the other age: R(other) · R(current)⁻¹ · p.
  const stageRotation = quatMultiply(otherRotation, quatConjugate(currentRotation));
  const otherUnit: UnitVector = [0, 0, 0];
  quatRotate(stageRotation, pointUnit[0], pointUnit[1], pointUnit[2], otherUnit);
  if (!isExtrapolated) return otherUnit;
  const mirroredUnit: UnitVector = [2 * pointUnit[0] - otherUnit[0], 2 * pointUnit[1] - otherUnit[1], 2 * pointUnit[2] - otherUnit[2]];
  const mirroredLength = Math.hypot(mirroredUnit[0], mirroredUnit[1], mirroredUnit[2]) || 1;
  return [mirroredUnit[0] / mirroredLength, mirroredUnit[1] / mirroredLength, mirroredUnit[2] / mirroredLength];
}
