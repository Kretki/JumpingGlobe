/** Coloured GL_LINES in 3-D (ECEF metres), for overlays that leave the ground: axes, lifted grids, field lines. */

import { WGS84_SEMI_MAJOR, writeSurfacePoint } from "../geodesy/wgs84Ellipsoid";
import type { UnitVector } from "../plates/sphericalCoords";

/** RGBA, 0..1. */
export type LineColor = [number, number, number, number];

/** A point in ECEF metres. */
export type SpacePoint = [number, number, number];

/**
 * Point on the ellipsoid surface under a direction.
 *
 * Usage: lines that start on, or follow, the ground.
 *
 * @param directionUnit - Unit direction (GPlates sphere).
 * @returns ECEF metres.
 */
export function groundPoint(directionUnit: UnitVector): SpacePoint {
  const pointBuffer = new Float32Array(3);
  writeSurfacePoint(directionUnit, pointBuffer, 0);
  return [pointBuffer[0], pointBuffer[1], pointBuffer[2]];
}

/**
 * Point at a distance from the Earth's centre along a direction.
 *
 * Usage: axis tips and field lines.
 *
 * @param directionUnit - Unit direction.
 * @param radiusInEarthRadii - Distance in equatorial Earth radii.
 * @returns ECEF metres.
 */
export function spacePoint(directionUnit: UnitVector, radiusInEarthRadii: number): SpacePoint {
  const radiusMeters = radiusInEarthRadii * WGS84_SEMI_MAJOR;
  return [directionUnit[0] * radiusMeters, directionUnit[1] * radiusMeters, directionUnit[2] * radiusMeters];
}

/**
 * Linear blend of two colours.
 *
 * Usage: red → blue gradient of field lines.
 *
 * @param startColor - Colour at fraction 0.
 * @param endColor - Colour at fraction 1.
 * @param fraction - 0..1.
 * @returns The blended colour.
 */
export function blendColors(startColor: LineColor, endColor: LineColor, fraction: number): LineColor {
  return [0, 1, 2, 3].map((channelIndex) => startColor[channelIndex] + (endColor[channelIndex] - startColor[channelIndex]) * fraction) as LineColor;
}

export class SpaceLineSet {
  /** Flat xyz in ECEF metres, two vertices per segment. */
  readonly positionValues: number[] = [];
  /** Flat rgba per vertex. */
  readonly colorValues: number[] = [];

  /**
   * Add one segment with a colour per end.
   *
   * Usage: every line primitive.
   *
   * @param startPoint - Start (ECEF metres).
   * @param endPoint - End (ECEF metres).
   * @param startColor - Colour at the start.
   * @param endColor - Colour at the end (defaults to the start colour).
   * @returns Nothing.
   */
  addSegment(startPoint: SpacePoint, endPoint: SpacePoint, startColor: LineColor, endColor: LineColor = startColor): void {
    this.positionValues.push(...startPoint, ...endPoint);
    this.colorValues.push(...startColor, ...endColor);
  }

  /**
   * Add a polyline with one colour per vertex.
   *
   * Usage: grid circles, field lines.
   *
   * @param linePoints - Vertices (ECEF metres).
   * @param vertexColors - One colour per vertex, or one colour for all.
   * @returns Nothing.
   */
  addPolyline(linePoints: SpacePoint[], vertexColors: LineColor[] | LineColor): void {
    const colorOfVertex = (pointIdx: number): LineColor => (Array.isArray(vertexColors[0]) ? (vertexColors as LineColor[])[pointIdx] : (vertexColors as LineColor));
    for (let pointIdx = 1; pointIdx < linePoints.length; pointIdx++) {
      this.addSegment(linePoints[pointIdx - 1], linePoints[pointIdx], colorOfVertex(pointIdx - 1), colorOfVertex(pointIdx));
    }
  }

  /**
   * Number of vertices.
   *
   * Usage: skip empty uploads.
   *
   * @returns positionValues.length / 3.
   */
  get vertexCount(): number {
    return this.positionValues.length / 3;
  }
}
