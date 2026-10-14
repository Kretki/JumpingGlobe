/**
 * Plate-motion ticks: short arrows just inside each plate's edge showing where that
 * part of the plate is heading (towards the present) and how fast. Two plates meeting
 * at a boundary each show their own motion, so convergence, divergence and shear
 * along the boundary are visible at a glance.
 */

import type { ResolvedPlate } from "../topology/topologyResolver";
import { ringInteriorOnLeft } from "../topology/sphericalRing";
import type { UnitVector } from "../sphericalCoords";
import { arcAngle, leftTangent, moveAlong, tangentToward } from "../unitVectorMath";
import type { PlateMover } from "./boundarySymbols";
import { sampleStations } from "./polylineSampler";
import type { SymbolGeometry } from "./symbolGeometry";

const TICK_SPACING = 5;
const TICK_INSET = 0.8;
const TICK_MAX_LENGTH = 2.5;
const TICK_HEAD = 0.35;
/** Speed drawn at full length (cm/yr); faster plates are capped. */
const FULL_LENGTH_SPEED_CM_YR = 10;
const EARTH_RADIUS_KM = 6371;
const MIN_SPEED_CM_YR = 0.2;

/**
 * Speed of a moving point in cm/yr.
 *
 * Usage: tick length.
 *
 * @param startUnit - Position now.
 * @param movedUnit - Position one Myr later.
 * @returns Speed (km/Myr ÷ 10 = cm/yr).
 */
export function speedCmPerYear(startUnit: UnitVector, movedUnit: UnitVector): number {
  return (arcAngle(startUnit, movedUnit) * EARTH_RADIUS_KM) / 10;
}

/**
 * Add the motion ticks of one plate.
 *
 * Usage: per resolved plate while the plate-motion layer is on.
 *
 * @param resolvedPlate - Plate polygon at the displayed age.
 * @param plateMover - Plate motion at the displayed age.
 * @param symbolScale - Symbol scale (radians).
 * @param symbolGeometry - Target geometry.
 * @returns Nothing; plates without rotation poles or barely moving get no ticks.
 */
export function addMotionTicks(resolvedPlate: ResolvedPlate, plateMover: PlateMover, symbolScale: number, symbolGeometry: SymbolGeometry): void {
  if (resolvedPlate.plateNumber === 0) return;
  const inwardSign = ringInteriorOnLeft(resolvedPlate.ringUnits) ? 1 : -1;
  for (const { pointUnit, tangentUnit } of sampleStations(resolvedPlate.ringUnits, TICK_SPACING * symbolScale, true)) {
    const tickBase = moveAlong(pointUnit, leftTangent(pointUnit, tangentUnit), inwardSign * TICK_INSET * symbolScale);
    const movedUnit = plateMover(resolvedPlate.plateNumber, tickBase, 1);
    if (!movedUnit) return;
    const plateSpeed = speedCmPerYear(tickBase, movedUnit);
    const motionDirection = tangentToward(tickBase, movedUnit);
    if (plateSpeed < MIN_SPEED_CM_YR || !motionDirection) continue;
    const tickLength = Math.min(plateSpeed / FULL_LENGTH_SPEED_CM_YR, 1) * TICK_MAX_LENGTH * symbolScale;
    symbolGeometry.addArrow(tickBase, motionDirection, tickLength, TICK_HEAD * symbolScale);
  }
}
