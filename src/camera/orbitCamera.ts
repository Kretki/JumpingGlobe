/** Orbit camera around the WGS84 globe: yaw/pitch of the look-at point and height above it. */

import { clampValue } from "../geodesy/angleMath";
import { ellipsoidRadiusAlong } from "../geodesy/wgs84Ellipsoid";

export const FIELD_OF_VIEW_Y = (45 * Math.PI) / 180;
export const MIN_HEIGHT_M = 50;
export const MAX_HEIGHT_M = 2e7;

const PITCH_LIMIT = 1.4;
/** Above this pitch the camera's up vector switches from north to the yaw direction. */
const POLAR_UP_PITCH = 1.2;

export class OrbitCamera {
  yawRadians = 0.6;
  pitchRadians = 0.35;
  heightMeters = 1e7;

  /**
   * Unit direction from the globe centre to the look-at point.
   *
   * Usage: camera placement and the look-at point.
   *
   * @returns [x, y, z].
   */
  viewDirection(): number[] {
    const cosPitch = Math.cos(this.pitchRadians);
    return [cosPitch * Math.sin(this.yawRadians), cosPitch * Math.cos(this.yawRadians), Math.sin(this.pitchRadians)];
  }

  /**
   * Camera position: heightMeters above the ellipsoid along the view direction.
   *
   * Usage: view matrix and picking.
   *
   * @returns ECEF [x, y, z] in metres.
   */
  cameraPosition(): number[] {
    const [directionX, directionY, directionZ] = this.viewDirection();
    const orbitRadius = ellipsoidRadiusAlong(directionX, directionY, directionZ) + this.heightMeters;
    return [directionX * orbitRadius, directionY * orbitRadius, directionZ * orbitRadius];
  }

  /**
   * Surface point below the camera.
   *
   * Usage: coordinate read-out and land loading.
   *
   * @returns ECEF [x, y, z] in metres.
   */
  lookAtSurfacePoint(): number[] {
    const [directionX, directionY, directionZ] = this.viewDirection();
    const surfaceRadius = ellipsoidRadiusAlong(directionX, directionY, directionZ);
    return [directionX * surfaceRadius, directionY * surfaceRadius, directionZ * surfaceRadius];
  }

  /**
   * Camera up vector (north, or the yaw direction near the poles).
   *
   * Usage: view matrix and picking.
   *
   * @returns [x, y, z].
   */
  upVector(): number[] {
    return Math.abs(this.pitchRadians) > POLAR_UP_PITCH ? [-Math.sin(this.yawRadians), -Math.cos(this.yawRadians), 0] : [0, 0, 1];
  }

  /**
   * Orbit angle per dragged pixel, so the ground follows the pointer.
   *
   * Usage: drag handling.
   *
   * @param viewportHeightPx - Canvas height in CSS pixels.
   * @returns Radians per pixel.
   */
  orbitRadiansPerPixel(viewportHeightPx: number): number {
    const metersPerPixel = (2 * this.heightMeters * Math.tan(FIELD_OF_VIEW_Y / 2)) / Math.max(viewportHeightPx, 1);
    const [directionX, directionY, directionZ] = this.viewDirection();
    return metersPerPixel / ellipsoidRadiusAlong(directionX, directionY, directionZ);
  }

  /**
   * Zoom sensitivity, growing logarithmically with height.
   *
   * Usage: wheel handling.
   *
   * @returns Exponent per wheel delta unit.
   */
  zoomGain(): number {
    const heightFraction = Math.log(this.heightMeters / MIN_HEIGHT_M) / Math.log(MAX_HEIGHT_M / MIN_HEIGHT_M);
    return 0.00045 + heightFraction * 0.0014;
  }

  /**
   * Orbit by a pointer drag.
   *
   * Usage: pointermove while dragging.
   *
   * @param deltaAlongX - Horizontal movement in pixels.
   * @param deltaAlongY - Vertical movement in pixels.
   * @param viewportHeightPx - Canvas height in CSS pixels.
   * @returns Nothing.
   */
  orbitByDrag(deltaAlongX: number, deltaAlongY: number, viewportHeightPx: number): void {
    const radiansPerPixel = this.orbitRadiansPerPixel(viewportHeightPx);
    this.yawRadians += deltaAlongX * radiansPerPixel;
    this.pitchRadians = clampValue(this.pitchRadians + deltaAlongY * radiansPerPixel, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /**
   * Zoom by a wheel delta.
   *
   * Usage: wheel events.
   *
   * @param wheelDelta - WheelEvent.deltaY.
   * @returns Nothing.
   */
  zoomByWheel(wheelDelta: number): void {
    const zoomFactor = Math.exp(wheelDelta * this.zoomGain());
    this.heightMeters = clampValue(this.heightMeters * zoomFactor, MIN_HEIGHT_M, MAX_HEIGHT_M);
  }
}
