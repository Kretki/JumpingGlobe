/** Ocean surface: a parametric WGS84 ellipsoid mesh. */

import { WGS84_SEMI_MAJOR, WGS84_SEMI_MINOR } from "../geodesy/wgs84Ellipsoid";

export type EllipsoidMesh = { positions: Float32Array; vertexNormals: Float32Array; triangleIndices: Uint16Array };

/**
 * Build a latitude/longitude grid on the WGS84 ellipsoid.
 *
 * Usage: once at start-up for the ocean.
 *
 * @param latitudeBands - Rows from pole to pole.
 * @param longitudeBands - Columns around the equator.
 * @returns Positions (metres), unit normals and 16-bit triangle indices.
 */
export function createEllipsoidMesh(latitudeBands: number, longitudeBands: number): EllipsoidMesh {
  const positionData: number[] = [];
  const normalData: number[] = [];
  const indexData: number[] = [];
  const majorSquared = WGS84_SEMI_MAJOR * WGS84_SEMI_MAJOR;
  const minorSquared = WGS84_SEMI_MINOR * WGS84_SEMI_MINOR;

  for (let latitudeIdx = 0; latitudeIdx <= latitudeBands; latitudeIdx++) {
    const polarAngle = (latitudeIdx * Math.PI) / latitudeBands;
    const sinPolar = Math.sin(polarAngle);
    const cosPolar = Math.cos(polarAngle);
    for (let longitudeIdx = 0; longitudeIdx <= longitudeBands; longitudeIdx++) {
      const azimuthAngle = (longitudeIdx * 2 * Math.PI) / longitudeBands;
      const surfaceX = WGS84_SEMI_MAJOR * sinPolar * Math.cos(azimuthAngle);
      const surfaceY = WGS84_SEMI_MAJOR * sinPolar * Math.sin(azimuthAngle);
      const surfaceZ = WGS84_SEMI_MINOR * cosPolar;
      positionData.push(surfaceX, surfaceY, surfaceZ);
      const gradientX = surfaceX / majorSquared;
      const gradientY = surfaceY / majorSquared;
      const gradientZ = surfaceZ / minorSquared;
      const gradientLength = Math.hypot(gradientX, gradientY, gradientZ) || 1;
      normalData.push(gradientX / gradientLength, gradientY / gradientLength, gradientZ / gradientLength);
    }
  }

  for (let latitudeIdx = 0; latitudeIdx < latitudeBands; latitudeIdx++) {
    for (let longitudeIdx = 0; longitudeIdx < longitudeBands; longitudeIdx++) {
      const upperVertex = latitudeIdx * (longitudeBands + 1) + longitudeIdx;
      const lowerVertex = upperVertex + longitudeBands + 1;
      indexData.push(upperVertex, lowerVertex, upperVertex + 1);
      indexData.push(lowerVertex, lowerVertex + 1, upperVertex + 1);
    }
  }

  return {
    positions: new Float32Array(positionData),
    vertexNormals: new Float32Array(normalData),
    triangleIndices: new Uint16Array(indexData),
  };
}
