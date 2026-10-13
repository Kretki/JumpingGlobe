/** Unit-quaternion helpers for plate rotations (mirror of server/quaternion_math.py; keep in sync). */

/** Unit quaternion [w, x, y, z]. */
export type Quaternion = [number, number, number, number];

export const IDENTITY_QUAT: Quaternion = [1, 0, 0, 0];

const DEG_TO_RAD = Math.PI / 180;
const SLERP_LINEAR_THRESHOLD = 0.9999995;

/**
 * Rotation quaternion of a finite Euler pole.
 *
 * Usage: convert each rotation-file pole.
 *
 * @param latitudeDeg - Pole latitude.
 * @param longitudeDeg - Pole longitude.
 * @param angleDeg - Rotation angle (right-handed about the pole).
 * @returns The unit quaternion.
 */
export function quatFromPole(latitudeDeg: number, longitudeDeg: number, angleDeg: number): Quaternion {
  const latitudeRad = latitudeDeg * DEG_TO_RAD;
  const longitudeRad = longitudeDeg * DEG_TO_RAD;
  const halfAngle = (angleDeg * DEG_TO_RAD) / 2;
  const sinHalfAngle = Math.sin(halfAngle);
  const cosLatitude = Math.cos(latitudeRad);
  return [
    Math.cos(halfAngle),
    sinHalfAngle * cosLatitude * Math.cos(longitudeRad),
    sinHalfAngle * cosLatitude * Math.sin(longitudeRad),
    sinHalfAngle * Math.sin(latitudeRad),
  ];
}

/**
 * Hamilton product leftQuat · rightQuat (apply right first, then left).
 *
 * Usage: compose a parent plate's total rotation with a child's relative rotation.
 *
 * @param leftQuat - Applied second.
 * @param rightQuat - Applied first.
 * @returns The product.
 */
export function quatMultiply(leftQuat: Quaternion, rightQuat: Quaternion): Quaternion {
  return [
    leftQuat[0] * rightQuat[0] - leftQuat[1] * rightQuat[1] - leftQuat[2] * rightQuat[2] - leftQuat[3] * rightQuat[3],
    leftQuat[0] * rightQuat[1] + leftQuat[1] * rightQuat[0] + leftQuat[2] * rightQuat[3] - leftQuat[3] * rightQuat[2],
    leftQuat[0] * rightQuat[2] - leftQuat[1] * rightQuat[3] + leftQuat[2] * rightQuat[0] + leftQuat[3] * rightQuat[1],
    leftQuat[0] * rightQuat[3] + leftQuat[1] * rightQuat[2] - leftQuat[2] * rightQuat[1] + leftQuat[3] * rightQuat[0],
  ];
}

/**
 * Conjugate (inverse rotation of a unit quaternion).
 *
 * Usage: rotate a reconstructed point back to present-day coordinates.
 *
 * @param inputQuat - Unit quaternion.
 * @returns [w, −x, −y, −z].
 */
export function quatConjugate(inputQuat: Quaternion): Quaternion {
  return [inputQuat[0], -inputQuat[1], -inputQuat[2], -inputQuat[3]];
}

/**
 * Spherical linear interpolation along the shorter arc.
 *
 * Usage: interpolate between two total poles of one sequence.
 *
 * @param startQuat - Quaternion at fraction 0.
 * @param endInput - Quaternion at fraction 1.
 * @param fraction - Interpolation parameter in [0, 1].
 * @returns The normalised interpolated quaternion.
 */
export function quatSlerp(startQuat: Quaternion, endInput: Quaternion, fraction: number): Quaternion {
  let targetQuat = endInput;
  let dotProduct = startQuat[0] * targetQuat[0] + startQuat[1] * targetQuat[1] + startQuat[2] * targetQuat[2] + startQuat[3] * targetQuat[3];
  if (dotProduct < 0) {
    targetQuat = [-targetQuat[0], -targetQuat[1], -targetQuat[2], -targetQuat[3]];
    dotProduct = -dotProduct;
  }
  let startWeight: number;
  let endWeight: number;
  if (dotProduct > SLERP_LINEAR_THRESHOLD) {
    startWeight = 1 - fraction;
    endWeight = fraction;
  } else {
    const arcAngle = Math.acos(Math.min(1, dotProduct));
    const sinOfArc = Math.sin(arcAngle);
    startWeight = Math.sin((1 - fraction) * arcAngle) / sinOfArc;
    endWeight = Math.sin(fraction * arcAngle) / sinOfArc;
  }
  const blendedQuat: Quaternion = [
    startWeight * startQuat[0] + endWeight * targetQuat[0],
    startWeight * startQuat[1] + endWeight * targetQuat[1],
    startWeight * startQuat[2] + endWeight * targetQuat[2],
    startWeight * startQuat[3] + endWeight * targetQuat[3],
  ];
  const magnitude = Math.hypot(blendedQuat[0], blendedQuat[1], blendedQuat[2], blendedQuat[3]) || 1;
  return [blendedQuat[0] / magnitude, blendedQuat[1] / magnitude, blendedQuat[2] / magnitude, blendedQuat[3] / magnitude];
}

/**
 * Rotate a vector by a unit quaternion, writing into a buffer.
 *
 * Usage: per-vertex reconstruction (allocation-free).
 *
 * @param rotationQuat - Unit quaternion.
 * @param inputVecX - Input x.
 * @param inputVecY - Input y.
 * @param inputVecZ - Input z.
 * @param targetBuffer - Output buffer.
 * @param bufferOffset - Index of the x component in the output.
 * @returns Nothing; writes three numbers.
 */
export function quatRotate(
  rotationQuat: Quaternion,
  inputVecX: number,
  inputVecY: number,
  inputVecZ: number,
  targetBuffer: number[] | Float32Array,
  bufferOffset = 0
): void {
  const [scalarPartW, axisPartX, axisPartY, axisPartZ] = rotationQuat;
  // t = 2 · cross(q.xyz, v); v' = v + w·t + cross(q.xyz, t)
  const tempVecX = 2 * (axisPartY * inputVecZ - axisPartZ * inputVecY);
  const tempVecY = 2 * (axisPartZ * inputVecX - axisPartX * inputVecZ);
  const tempVecZ = 2 * (axisPartX * inputVecY - axisPartY * inputVecX);
  targetBuffer[bufferOffset] = inputVecX + scalarPartW * tempVecX + (axisPartY * tempVecZ - axisPartZ * tempVecY);
  targetBuffer[bufferOffset + 1] = inputVecY + scalarPartW * tempVecY + (axisPartZ * tempVecX - axisPartX * tempVecZ);
  targetBuffer[bufferOffset + 2] = inputVecZ + scalarPartW * tempVecZ + (axisPartX * tempVecY - axisPartY * tempVecX);
}
