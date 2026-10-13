/** Column-major 4×4 matrices for WebGL. */

export type Matrix4x4 = Float32Array;

/**
 * Identity matrix.
 *
 * Usage: model matrix of the globe.
 *
 * @returns A new identity matrix.
 */
export function mat4Identity(): Matrix4x4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/**
 * Perspective projection matrix.
 *
 * Usage: once per frame.
 *
 * @param fieldOfViewY - Vertical field of view in radians.
 * @param aspectRatio - Viewport width / height.
 * @param nearPlane - Near clip distance (> 0).
 * @param farPlane - Far clip distance.
 * @returns The projection matrix.
 */
export function mat4Perspective(fieldOfViewY: number, aspectRatio: number, nearPlane: number, farPlane: number): Matrix4x4 {
  const focalScale = 1 / Math.tan(fieldOfViewY / 2);
  const depthScale = 1 / (nearPlane - farPlane);
  const resultMatrix = new Float32Array(16);
  resultMatrix[0] = focalScale / aspectRatio;
  resultMatrix[5] = focalScale;
  resultMatrix[10] = (farPlane + nearPlane) * depthScale;
  resultMatrix[11] = -1;
  resultMatrix[14] = 2 * farPlane * nearPlane * depthScale;
  return resultMatrix;
}

/**
 * View matrix looking from an eye point at a target.
 *
 * Usage: camera view matrix.
 *
 * @param eyePosition - Camera position.
 * @param targetPoint - Point looked at.
 * @param upDirection - Approximate up vector.
 * @returns The view matrix.
 */
export function mat4LookAt(eyePosition: number[], targetPoint: number[], upDirection: number[]): Matrix4x4 {
  const [eyePointX, eyePointY, eyePointZ] = eyePosition;
  let forwardX = eyePointX - targetPoint[0];
  let forwardY = eyePointY - targetPoint[1];
  let forwardZ = eyePointZ - targetPoint[2];
  let axisLength = Math.hypot(forwardX, forwardY, forwardZ) || 1;
  forwardX /= axisLength;
  forwardY /= axisLength;
  forwardZ /= axisLength;

  let sideAxisX = upDirection[1] * forwardZ - upDirection[2] * forwardY;
  let sideAxisY = upDirection[2] * forwardX - upDirection[0] * forwardZ;
  let sideAxisZ = upDirection[0] * forwardY - upDirection[1] * forwardX;
  axisLength = Math.hypot(sideAxisX, sideAxisY, sideAxisZ) || 1;
  sideAxisX /= axisLength;
  sideAxisY /= axisLength;
  sideAxisZ /= axisLength;

  const upwardAxisX = forwardY * sideAxisZ - forwardZ * sideAxisY;
  const upwardAxisY = forwardZ * sideAxisX - forwardX * sideAxisZ;
  const upwardAxisZ = forwardX * sideAxisY - forwardY * sideAxisX;

  const resultMatrix = mat4Identity();
  resultMatrix[0] = sideAxisX;
  resultMatrix[1] = upwardAxisX;
  resultMatrix[2] = forwardX;
  resultMatrix[4] = sideAxisY;
  resultMatrix[5] = upwardAxisY;
  resultMatrix[6] = forwardY;
  resultMatrix[8] = sideAxisZ;
  resultMatrix[9] = upwardAxisZ;
  resultMatrix[10] = forwardZ;
  resultMatrix[12] = -(sideAxisX * eyePointX + sideAxisY * eyePointY + sideAxisZ * eyePointZ);
  resultMatrix[13] = -(upwardAxisX * eyePointX + upwardAxisY * eyePointY + upwardAxisZ * eyePointZ);
  resultMatrix[14] = -(forwardX * eyePointX + forwardY * eyePointY + forwardZ * eyePointZ);
  return resultMatrix;
}

/**
 * Matrix product leftMatrix · rightMatrix.
 *
 * Usage: model-view-projection.
 *
 * @param leftMatrix - Left operand.
 * @param rightMatrix - Right operand.
 * @returns A new product matrix.
 */
export function mat4Multiply(leftMatrix: Matrix4x4, rightMatrix: Matrix4x4): Matrix4x4 {
  const resultMatrix = new Float32Array(16);
  for (let columnIdx = 0; columnIdx < 4; columnIdx++) {
    for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
      resultMatrix[columnIdx * 4 + rowIndex] =
        leftMatrix[rowIndex] * rightMatrix[columnIdx * 4] +
        leftMatrix[4 + rowIndex] * rightMatrix[columnIdx * 4 + 1] +
        leftMatrix[8 + rowIndex] * rightMatrix[columnIdx * 4 + 2] +
        leftMatrix[12 + rowIndex] * rightMatrix[columnIdx * 4 + 3];
    }
  }
  return resultMatrix;
}
