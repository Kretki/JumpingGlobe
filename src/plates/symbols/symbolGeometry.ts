/** Collect overlay primitives (GL_LINES pairs and GL_TRIANGLES) as unit vectors on the sphere. */

import { appendEdgeSegments } from "../outlineGeometry";
import type { UnitVector } from "../sphericalCoords";
import { crossProduct, moveAlong } from "../unitVectorMath";

/** Primitives of one colour: line pairs and triangles as flat xyz unit-vector lists. */
export class SymbolGeometry {
  readonly lineValues: number[] = [];
  readonly triangleValues: number[] = [];

  /**
   * Add a polyline, densified so it follows the sphere.
   *
   * Usage: boundary lines and highlight outlines.
   *
   * @param lineUnits - Polyline vertices.
   * @param isClosed - Also join the last vertex to the first.
   * @returns Nothing.
   */
  addPolyline(lineUnits: UnitVector[], isClosed = false): void {
    for (let pointIdx = 1; pointIdx < lineUnits.length; pointIdx++) appendEdgeSegments(lineUnits[pointIdx - 1], lineUnits[pointIdx], this.lineValues);
    if (isClosed && lineUnits.length > 2) appendEdgeSegments(lineUnits[lineUnits.length - 1], lineUnits[0], this.lineValues);
  }

  /**
   * Add one short straight segment (no densification; for symbol strokes).
   *
   * Usage: arrow shafts and heads, motion ticks.
   *
   * @param startUnit - Start point.
   * @param arcEndUnit - End point.
   * @returns Nothing.
   */
  addStroke(startUnit: UnitVector, arcEndUnit: UnitVector): void {
    this.lineValues.push(startUnit[0], startUnit[1], startUnit[2], arcEndUnit[0], arcEndUnit[1], arcEndUnit[2]);
  }

  /**
   * Add a filled triangle.
   *
   * Usage: subduction teeth, plate fills.
   *
   * @param firstUnit - First corner.
   * @param secondUnit - Second corner.
   * @param thirdUnit - Third corner.
   * @returns Nothing.
   */
  addTriangle(firstUnit: UnitVector, secondUnit: UnitVector, thirdUnit: UnitVector): void {
    this.triangleValues.push(
      firstUnit[0], firstUnit[1], firstUnit[2],
      secondUnit[0], secondUnit[1], secondUnit[2],
      thirdUnit[0], thirdUnit[1], thirdUnit[2]
    );
  }

  /**
   * Add an arrow: shaft from a point along a tangent direction, with a two-stroke head.
   *
   * Usage: spreading arrows, transform slip arrows, motion ticks.
   *
   * @param baseUnit - Arrow tail.
   * @param directionUnit - Unit tangent at baseUnit the arrow points along.
   * @param lengthRad - Shaft length (radians on the unit sphere).
   * @param headLengthRad - Length of each head stroke.
   * @returns Nothing.
   */
  addArrow(baseUnit: UnitVector, directionUnit: UnitVector, lengthRad: number, headLengthRad: number): void {
    const arrowTipUnit = moveAlong(baseUnit, directionUnit, lengthRad);
    this.addStroke(baseUnit, arrowTipUnit);
    // Back along the shaft, splayed ±30° (directions in the tangent plane at the tip, approximated at the base).
    const sideUnit = crossProduct(baseUnit, directionUnit);
    for (const sideSign of [1, -1]) {
      const headDirection: UnitVector = [
        -directionUnit[0] * 0.866 + sideUnit[0] * 0.5 * sideSign,
        -directionUnit[1] * 0.866 + sideUnit[1] * 0.5 * sideSign,
        -directionUnit[2] * 0.866 + sideUnit[2] * 0.5 * sideSign,
      ];
      this.addStroke(arrowTipUnit, moveAlong(arrowTipUnit, headDirection, headLengthRad));
    }
  }
}
