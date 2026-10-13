/** Ray-cast a screen pixel onto the WGS84 ellipsoid. */

import { ecefToGeodeticHeight, WGS84_SEMI_MAJOR, WGS84_SEMI_MINOR } from "../geodesy/wgs84Ellipsoid";
import { FIELD_OF_VIEW_Y, type OrbitCamera } from "./orbitCamera";

/**
 * Normalise a 3-vector in place.
 *
 * Usage: camera basis vectors.
 *
 * @param inputVector - Vector to normalise.
 * @returns The same array.
 */
function normalizeInPlace(inputVector: number[]): number[] {
  const vectorLength = Math.hypot(inputVector[0], inputVector[1], inputVector[2]);
  for (let componentIdx = 0; componentIdx < 3; componentIdx++) inputVector[componentIdx] /= vectorLength;
  return inputVector;
}

/**
 * World-space ray direction through a pixel.
 *
 * Usage: first step of pickGlobe.
 *
 * @param orbitCamera - Camera.
 * @param eyePosition - Camera position.
 * @param deviceCoordX - Normalised device x (−1..1).
 * @param deviceCoordY - Normalised device y (−1..1).
 * @param aspectRatio - Canvas width / height.
 * @returns Ray direction (not normalised).
 */
function pixelRay(orbitCamera: OrbitCamera, eyePosition: number[], deviceCoordX: number, deviceCoordY: number, aspectRatio: number): number[] {
  const forwardDir = normalizeInPlace([-eyePosition[0], -eyePosition[1], -eyePosition[2]]);
  const upDirection = orbitCamera.upVector();
  const rightDir = normalizeInPlace([
    forwardDir[1] * upDirection[2] - forwardDir[2] * upDirection[1],
    forwardDir[2] * upDirection[0] - forwardDir[0] * upDirection[2],
    forwardDir[0] * upDirection[1] - forwardDir[1] * upDirection[0],
  ]);
  const trueUpDir = [
    rightDir[1] * forwardDir[2] - rightDir[2] * forwardDir[1],
    rightDir[2] * forwardDir[0] - rightDir[0] * forwardDir[2],
    rightDir[0] * forwardDir[1] - rightDir[1] * forwardDir[0],
  ];
  const tanHalfFov = Math.tan(FIELD_OF_VIEW_Y / 2);
  return [0, 1, 2].map(
    (axisIndex) =>
      forwardDir[axisIndex] + deviceCoordX * tanHalfFov * aspectRatio * rightDir[axisIndex] + deviceCoordY * tanHalfFov * trueUpDir[axisIndex]
  );
}

/**
 * Geodetic lon/lat of the globe surface under a client pixel.
 *
 * Usage: click selection.
 *
 * @param orbitCamera - Camera.
 * @param canvasRect - Canvas bounding rectangle.
 * @param pointerClientX - Pointer x in client pixels.
 * @param pointerClientY - Pointer y in client pixels.
 * @returns [longitude°, latitude°], or null when the ray misses the globe.
 */
export function pickGlobe(orbitCamera: OrbitCamera, canvasRect: DOMRect, pointerClientX: number, pointerClientY: number): [number, number] | null {
  const deviceCoordX = ((pointerClientX - canvasRect.left) / canvasRect.width) * 2 - 1;
  const deviceCoordY = 1 - ((pointerClientY - canvasRect.top) / canvasRect.height) * 2;
  const eyePosition = orbitCamera.cameraPosition();
  const rayDirection = pixelRay(orbitCamera, eyePosition, deviceCoordX, deviceCoordY, canvasRect.width / canvasRect.height);
  const majorSquared = WGS84_SEMI_MAJOR * WGS84_SEMI_MAJOR;
  const minorSquared = WGS84_SEMI_MINOR * WGS84_SEMI_MINOR;
  const quadCoefA = (rayDirection[0] * rayDirection[0] + rayDirection[1] * rayDirection[1]) / majorSquared + (rayDirection[2] * rayDirection[2]) / minorSquared;
  const quadCoefB =
    2 * ((eyePosition[0] * rayDirection[0] + eyePosition[1] * rayDirection[1]) / majorSquared + (eyePosition[2] * rayDirection[2]) / minorSquared);
  const quadCoefC =
    (eyePosition[0] * eyePosition[0] + eyePosition[1] * eyePosition[1]) / majorSquared +
    (eyePosition[2] * eyePosition[2]) / minorSquared -
    1;
  const discriminant = quadCoefB * quadCoefB - 4 * quadCoefA * quadCoefC;
  if (discriminant < 0) return null;
  const rayParam = (-quadCoefB - Math.sqrt(discriminant)) / (2 * quadCoefA);
  if (rayParam <= 0) return null;
  const hitPoint = ecefToGeodeticHeight(
    eyePosition[0] + rayParam * rayDirection[0],
    eyePosition[1] + rayParam * rayDirection[1],
    eyePosition[2] + rayParam * rayDirection[2]
  );
  return [hitPoint.longitudeDeg, hitPoint.latitudeDeg];
}
