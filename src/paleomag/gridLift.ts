/**
 * Height of the paleomagnetic overlays above the ground. The TPW grid floats above the
 * globe when seen from far away and settles on the ground once the camera is lower than
 * lod.json ``paleoMagnetics.gridGroundHeightM``.
 */

import lodSettings from "../../lod.json";
import { WGS84_SEMI_MAJOR } from "../geodesy/wgs84Ellipsoid";

const paleoSettings = lodSettings.paleoMagnetics;
/** Below this camera height the grid lies on the ground. */
export const GRID_GROUND_HEIGHT_M = paleoSettings.gridGroundHeightM;
/** Lift of the floating grid, as a fraction of the Earth radius. */
const GRID_LIFT_FRACTION = paleoSettings.gridLiftFraction;
/** The lift grows from 0 at GRID_GROUND_HEIGHT_M to full at this multiple of it. */
const FULL_LIFT_HEIGHT_FACTOR = 2;
/** Ground-level overlays sit this far above the land (as the tectonic overlay) to avoid z-fighting. */
const MIN_GROUND_LIFT_M = 25;
const MAX_GROUND_LIFT_M = 35_000;
const GROUND_LIFT_PER_HEIGHT = 0.0035;

/**
 * Radial scale that keeps ground-level lines just above the land.
 *
 * Usage: pole markers, and the grid when the camera is low.
 *
 * @param cameraHeightM - Camera height above the surface.
 * @returns Scale factor slightly above 1.
 */
export function groundLiftScale(cameraHeightM: number): number {
  const liftMeters = Math.min(MAX_GROUND_LIFT_M, Math.max(MIN_GROUND_LIFT_M, cameraHeightM * GROUND_LIFT_PER_HEIGHT));
  return 1 + liftMeters / WGS84_SEMI_MAJOR;
}

/**
 * Radial scale of the TPW grid at a camera height.
 *
 * Usage: every frame while the grid is shown (lines and labels).
 *
 * @param cameraHeightM - Camera height above the surface.
 * @returns groundLiftScale below GRID_GROUND_HEIGHT_M, 1 + GRID_LIFT_FRACTION from twice that
 *   height up, and a linear blend in between.
 */
export function gridLiftScale(cameraHeightM: number): number {
  const groundScale = groundLiftScale(cameraHeightM);
  const blendFraction = Math.min(1, Math.max(0, (cameraHeightM - GRID_GROUND_HEIGHT_M) / (GRID_GROUND_HEIGHT_M * (FULL_LIFT_HEIGHT_FACTOR - 1))));
  return groundScale + (1 + GRID_LIFT_FRACTION - groundScale) * blendFraction;
}
