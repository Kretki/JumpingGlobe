/** Evenly spaced stations (point + direction) along a polyline on the sphere, for placing symbols. */

import type { UnitVector } from "../sphericalCoords";
import { arcAngle, pointAlongArc, tangentToward } from "../unitVectorMath";

/** A symbol station: position and unit tangent pointing along the line. */
export type LineStation = { pointUnit: UnitVector; tangentUnit: UnitVector };

/**
 * Stations every spacingRad along a polyline, starting half a spacing in.
 *
 * Usage: subduction teeth, spreading arrows, motion ticks. Lines shorter than one
 * spacing get a single station at their middle so short boundaries still show a symbol.
 *
 * @param lineUnits - Polyline (≥ 2 points).
 * @param spacingRad - Distance between stations (radians, > 0).
 * @param isClosed - Also walk the closing edge (rings).
 * @returns Stations in order along the line.
 */
export function sampleStations(lineUnits: UnitVector[], spacingRad: number, isClosed = false): LineStation[] {
  const edgeList: [UnitVector, UnitVector][] = [];
  for (let pointIdx = 1; pointIdx < lineUnits.length; pointIdx++) edgeList.push([lineUnits[pointIdx - 1], lineUnits[pointIdx]]);
  if (isClosed && lineUnits.length > 2) edgeList.push([lineUnits[lineUnits.length - 1], lineUnits[0]]);
  const edgeLengths = edgeList.map(([startUnit, arcEndUnit]) => arcAngle(startUnit, arcEndUnit));
  const totalLength = edgeLengths.reduce((lengthSum, edgeLength) => lengthSum + edgeLength, 0);
  if (totalLength <= 0) return [];
  const firstOffset = totalLength < spacingRad ? totalLength / 2 : spacingRad / 2;
  const stationList: LineStation[] = [];
  let nextOffset = firstOffset;
  let walkedLength = 0;
  edgeList.forEach(([startUnit, arcEndUnit], edgeIndex) => {
    const edgeLength = edgeLengths[edgeIndex];
    while (edgeLength > 0 && nextOffset <= walkedLength + edgeLength) {
      const pointUnit = pointAlongArc(startUnit, arcEndUnit, (nextOffset - walkedLength) / edgeLength);
      const tangentUnit = tangentToward(pointUnit, arcEndUnit) ?? tangentToward(startUnit, arcEndUnit);
      if (tangentUnit) stationList.push({ pointUnit, tangentUnit });
      nextOffset += spacingRad;
    }
    walkedLength += edgeLength;
  });
  return stationList;
}
