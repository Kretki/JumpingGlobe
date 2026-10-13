/** Local 2D charts (ENU tangent plane or polar azimuthal) used to triangulate polygons with earcut. */

import { normalizeLongitude } from "../geodesy/angleMath";
import {
  ecefToLonLat,
  lonLatNormal,
  lonLatToEcef,
  normalizeVector,
  WGS84_SEMI_MAJOR,
  type LonLatPoint,
  type Vector3d,
} from "../geodesy/wgs84Ellipsoid";
import { LAND_HEIGHT_M } from "./geodesicDensify";
import type { PoleKind } from "./poleDetection";

export const POLAR_CHART_LAT_DEG = 75;

/** Local east/north/up frame at a chart origin. */
export type EnuFrame = {
  originEcef: Vector3d;
  originLon: number;
  originLat: number;
  eastAxis: Vector3d;
  northAxis: Vector3d;
  upwardAxis: Vector3d;
};

export type ChartKind = "enu" | "polar_n" | "polar_s";

/** A projection from lon/lat to a plane. */
export type PlaneChart = {
  chartKind: ChartKind;
  enuFrame?: EnuFrame;
  radiusMeters: number;
};

/**
 * Cross product of two vectors.
 *
 * Usage: building orthonormal frames.
 *
 * @param firstVector - Left operand.
 * @param secondVector - Right operand.
 * @returns firstVector × secondVector.
 */
function crossProduct(firstVector: Vector3d, secondVector: Vector3d): Vector3d {
  return [
    firstVector[1] * secondVector[2] - firstVector[2] * secondVector[1],
    firstVector[2] * secondVector[0] - firstVector[0] * secondVector[2],
    firstVector[0] * secondVector[1] - firstVector[1] * secondVector[0],
  ];
}

/**
 * Normalise a 3-vector.
 *
 * Usage: frame axes.
 *
 * @param inputVector - Vector to normalise.
 * @returns Unit vector.
 */
function unitVectorOf(inputVector: Vector3d): Vector3d {
  return normalizeVector(inputVector[0], inputVector[1], inputVector[2]);
}

/**
 * Build an east/north/up frame at a geodetic position.
 *
 * Usage: ENU charts for polygons away from the poles.
 *
 * @param originLon - Origin longitude in degrees.
 * @param originLat - Origin latitude in degrees.
 * @param heightMeters - Origin height above the ellipsoid.
 * @returns The frame.
 */
export function makeEnuFrame(originLon: number, originLat: number, heightMeters = LAND_HEIGHT_M): EnuFrame {
  const originEcef = lonLatToEcef(originLon, originLat, heightMeters);
  const upwardAxis = lonLatNormal(originLon, originLat);
  const referenceAxis: Vector3d = Math.abs(upwardAxis[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1];
  let eastAxis = unitVectorOf(crossProduct(referenceAxis, upwardAxis));
  if (Math.hypot(eastAxis[0], eastAxis[1], eastAxis[2]) < 1e-12) {
    eastAxis = unitVectorOf(crossProduct([1, 0, 0], upwardAxis));
  }
  const northAxis = unitVectorOf(crossProduct(upwardAxis, eastAxis));
  return { originEcef, originLon, originLat, eastAxis, northAxis, upwardAxis };
}

/**
 * Project an ECEF point into an ENU frame's horizontal plane.
 *
 * Usage: chart coordinates for earcut.
 *
 * @param ecefPoint - Point in ECEF metres.
 * @param enuFrame - Target frame.
 * @returns [east, north] in metres.
 */
export function ecefToEnu(ecefPoint: Vector3d, enuFrame: EnuFrame): [number, number] {
  const offsetVecX = ecefPoint[0] - enuFrame.originEcef[0];
  const offsetVecY = ecefPoint[1] - enuFrame.originEcef[1];
  const offsetVecZ = ecefPoint[2] - enuFrame.originEcef[2];
  return [
    offsetVecX * enuFrame.eastAxis[0] + offsetVecY * enuFrame.eastAxis[1] + offsetVecZ * enuFrame.eastAxis[2],
    offsetVecX * enuFrame.northAxis[0] + offsetVecY * enuFrame.northAxis[1] + offsetVecZ * enuFrame.northAxis[2],
  ];
}

/**
 * Azimuthal equidistant projection about a pole: x = ρ cos λ, y = ρ sin λ.
 *
 * Usage: charts for high-latitude polygons.
 *
 * @param longitudeDeg - Longitude in degrees.
 * @param latitudeDeg - Latitude in degrees.
 * @param isNorthPole - True for the north pole, false for the south pole.
 * @returns Planar [x, y] in metres.
 */
export function lonLatToPolar(longitudeDeg: number, latitudeDeg: number, isNorthPole: boolean): [number, number] {
  const sphereRadius = WGS84_SEMI_MAJOR;
  const latitudeRad = (latitudeDeg * Math.PI) / 180;
  const longitudeRad = (longitudeDeg * Math.PI) / 180;
  const polarDistance = isNorthPole
    ? sphereRadius * (Math.PI / 2 - latitudeRad)
    : sphereRadius * (Math.PI / 2 + latitudeRad);
  return [polarDistance * Math.cos(longitudeRad), polarDistance * Math.sin(longitudeRad)];
}

/**
 * Chart centre from the mean of the ring's unit directions (dateline-safe).
 *
 * Usage: origin of an ENU chart.
 *
 * @param ringPoints - Ring vertices.
 * @returns Geocentric [longitude°, latitude°] of the mean direction.
 */
export function chartCenterLonLat(ringPoints: LonLatPoint[]): LonLatPoint {
  let sumVectorX = 0;
  let sumVectorY = 0;
  let sumVectorZ = 0;
  for (const [longitudeDeg, latitudeDeg] of ringPoints) {
    const ecefPoint = lonLatToEcef(longitudeDeg, latitudeDeg, 0);
    const unitVector = normalizeVector(ecefPoint[0], ecefPoint[1], ecefPoint[2]);
    sumVectorX += unitVector[0];
    sumVectorY += unitVector[1];
    sumVectorZ += unitVector[2];
  }
  const sumLength = Math.hypot(sumVectorX, sumVectorY, sumVectorZ) || 1;
  return ecefToLonLat(sumVectorX / sumLength, sumVectorY / sumLength, sumVectorZ / sumLength);
}

/**
 * Choose a chart for a polygon exterior.
 *
 * Usage: once per polygon piece before triangulation.
 *
 * @param exteriorRing - Exterior ring vertices.
 * @param poleKind - Pole enclosed by the ring, if any.
 * @param heightMeters - Height of the ENU origin.
 * @returns Polar chart near/around poles, otherwise an ENU chart at the ring centre.
 */
export function makeChart(exteriorRing: LonLatPoint[], poleKind: PoleKind, heightMeters = LAND_HEIGHT_M): PlaneChart {
  if (poleKind === "north") return { chartKind: "polar_n", radiusMeters: WGS84_SEMI_MAJOR };
  if (poleKind === "south") return { chartKind: "polar_s", radiusMeters: WGS84_SEMI_MAJOR };

  const [centerLon, centerLat] = chartCenterLonLat(exteriorRing);
  if (centerLat > POLAR_CHART_LAT_DEG) return { chartKind: "polar_n", radiusMeters: WGS84_SEMI_MAJOR };
  if (centerLat < -POLAR_CHART_LAT_DEG) return { chartKind: "polar_s", radiusMeters: WGS84_SEMI_MAJOR };

  return { chartKind: "enu", enuFrame: makeEnuFrame(centerLon, centerLat, heightMeters), radiusMeters: WGS84_SEMI_MAJOR };
}

/**
 * Project a lon/lat point into a chart.
 *
 * Usage: per ring vertex before earcut.
 *
 * @param longitudeDeg - Longitude (any frame; polar charts normalise it).
 * @param latitudeDeg - Latitude.
 * @param planeChart - Chart from makeChart.
 * @param heightMeters - Height used for ENU projection.
 * @returns Planar [x, y] in metres.
 */
export function projectToChart(
  longitudeDeg: number,
  latitudeDeg: number,
  planeChart: PlaneChart,
  heightMeters = LAND_HEIGHT_M
): [number, number] {
  if (planeChart.chartKind === "polar_n") return lonLatToPolar(normalizeLongitude(longitudeDeg), latitudeDeg, true);
  if (planeChart.chartKind === "polar_s") return lonLatToPolar(normalizeLongitude(longitudeDeg), latitudeDeg, false);
  return ecefToEnu(lonLatToEcef(longitudeDeg, latitudeDeg, heightMeters), planeChart.enuFrame!);
}

/**
 * Signed shoelace area of a planar polygon.
 *
 * Usage: orientation of charted rings.
 *
 * @param planePoints - Polygon vertices.
 * @returns Signed area (positive = counter-clockwise).
 */
export function signedArea2D(planePoints: [number, number][]): number {
  let doubledArea = 0;
  const pointCount = planePoints.length;
  for (let pointIdx = 0; pointIdx < pointCount; pointIdx++) {
    const nextIndex = (pointIdx + 1) % pointCount;
    doubledArea += planePoints[pointIdx][0] * planePoints[nextIndex][1] - planePoints[nextIndex][0] * planePoints[pointIdx][1];
  }
  return doubledArea / 2;
}
