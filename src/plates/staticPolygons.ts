/**
 * Static polygons of the plate model (present-day coordinates) and the "which plate is under this point" lookup.
 *
 * A point clicked at age t lies on plate P if rotating it back by P's rotation at t
 * lands inside one of P's static polygons valid at t.
 */

import { IDENTITY_QUAT, quatConjugate, quatRotate } from "./quaternionMath";
import type { RotationTree } from "./rotationTree";
import { lonLatToUnit, unitToLonLat, type UnitVector } from "./sphericalCoords";

export type StaticPolygon = {
  plateNumber: number;
  plateName: string;
  appearAgeMa: number;
  vanishAgeMa: number;
  /** [exterior, ...holes] per polygon, lon/lat. */
  polygonRings: number[][][][];
  /** [west, south, east, north] of all exteriors. */
  envelope: [number, number, number, number];
};

/** Result of a plate lookup. */
export type PlateHit = { staticPolygon: StaticPolygon; presentLon: number; presentLat: number; presentUnit: UnitVector };

/** Minimal FeatureCollection shape of /api/land (GeoJSON member names). */
export type StaticFeatureCollection = {
  features: { properties?: Record<string, unknown>; geometry: { type: string; coordinates: unknown } | null }[];
};

/**
 * Even–odd point-in-ring test.
 *
 * Usage: plate lookup.
 *
 * @param testPointX - Longitude.
 * @param testPointY - Latitude.
 * @param ringCoords - Ring vertices.
 * @returns True when inside.
 */
function pointInPolygonRing(testPointX: number, testPointY: number, ringCoords: number[][]): boolean {
  let isInside = false;
  for (let currentIdx = 0, previousIdx = ringCoords.length - 1; currentIdx < ringCoords.length; previousIdx = currentIdx++) {
    const [currentX, currentY] = ringCoords[currentIdx];
    const [previousX, previousY] = ringCoords[previousIdx];
    if (
      currentY > testPointY !== previousY > testPointY &&
      testPointX < ((previousX - currentX) * (testPointY - currentY)) / (previousY - currentY) + currentX
    ) {
      isInside = !isInside;
    }
  }
  return isInside;
}

/**
 * Envelope of the exteriors of a set of polygons.
 *
 * Usage: cheap pre-filter of the plate lookup.
 *
 * @param polygonRings - Polygons (exterior first).
 * @returns [west, south, east, north].
 */
function exteriorEnvelope(polygonRings: number[][][][]): [number, number, number, number] {
  let westEdge = Infinity;
  let southEdge = Infinity;
  let eastEdge = -Infinity;
  let northEdge = -Infinity;
  for (const polygonCoords of polygonRings) {
    for (const [coordinateX, coordinateY] of polygonCoords[0]) {
      if (coordinateX < westEdge) westEdge = coordinateX;
      if (coordinateX > eastEdge) eastEdge = coordinateX;
      if (coordinateY < southEdge) southEdge = coordinateY;
      if (coordinateY > northEdge) northEdge = coordinateY;
    }
  }
  return [westEdge, southEdge, eastEdge, northEdge];
}

/**
 * Parse the /api/land FeatureCollection of the static-polygon file (e.g. cao_static.gpkg).
 *
 * Usage: once, when the static-polygon layer is ready.
 *
 * @param featureCollection - Response body (``plate_id``, ``name``, ``from_age``, ``to_age`` properties).
 * @returns Static polygons; features without a numeric plate id are skipped.
 */
export function parseStaticPolygons(featureCollection: StaticFeatureCollection): StaticPolygon[] {
  const staticList: StaticPolygon[] = [];
  for (const staticFeature of featureCollection.features) {
    const geometry = staticFeature.geometry;
    const featureProps = staticFeature.properties ?? {};
    if (!geometry || typeof featureProps.plate_id !== "number") continue;
    const polygonRings = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
    staticList.push({
      plateNumber: featureProps.plate_id,
      plateName: typeof featureProps.name === "string" ? featureProps.name : "",
      appearAgeMa: typeof featureProps.from_age === "number" ? featureProps.from_age : 1e6,
      vanishAgeMa: typeof featureProps.to_age === "number" ? featureProps.to_age : 0,
      polygonRings,
      envelope: exteriorEnvelope(polygonRings),
    });
  }
  return staticList;
}

/**
 * Plate under a point as displayed at an age, with that point's present-day position.
 *
 * Usage: click selection.
 *
 * @param staticList - Static polygons.
 * @param rotationTree - Rotation model.
 * @param longitudeDeg - Clicked longitude (at the age).
 * @param latitudeDeg - Clicked latitude (at the age).
 * @param ageInMyr - Displayed age.
 * @returns The hit, or null when no plate covers the point.
 */
export function findPlateAt(
  staticList: StaticPolygon[],
  rotationTree: RotationTree,
  longitudeDeg: number,
  latitudeDeg: number,
  ageInMyr: number
): PlateHit | null {
  const clickedUnit = lonLatToUnit(longitudeDeg, latitudeDeg);
  const rotatedBack: UnitVector = [0, 0, 0];
  const presentByPlate = new Map<number, [number, number] | null>();
  // Older-lived polygons first, so tiny overlaps resolve like the plate tagging.
  const candidateList = staticList
    .filter((staticPolygon) => ageInMyr <= staticPolygon.appearAgeMa && ageInMyr >= staticPolygon.vanishAgeMa)
    .sort((firstPolygon, secondPolygon) => secondPolygon.appearAgeMa - firstPolygon.appearAgeMa);
  for (const staticPolygon of candidateList) {
    let presentLonLat = presentByPlate.get(staticPolygon.plateNumber);
    if (presentLonLat === undefined) {
      const plateQuat = ageInMyr <= 0 ? IDENTITY_QUAT : rotationTree.totalRotation(staticPolygon.plateNumber, ageInMyr);
      if (plateQuat) {
        quatRotate(quatConjugate(plateQuat), clickedUnit[0], clickedUnit[1], clickedUnit[2], rotatedBack);
        presentLonLat = unitToLonLat(rotatedBack);
      } else presentLonLat = null;
      presentByPlate.set(staticPolygon.plateNumber, presentLonLat);
    }
    if (!presentLonLat) continue;
    const [presentLon, presentLat] = presentLonLat;
    const envelope = staticPolygon.envelope;
    if (presentLon < envelope[0] || presentLon > envelope[2] || presentLat < envelope[1] || presentLat > envelope[3]) continue;
    for (const polygonCoords of staticPolygon.polygonRings) {
      if (!pointInPolygonRing(presentLon, presentLat, polygonCoords[0])) continue;
      if (polygonCoords.slice(1).some((holeCoords) => pointInPolygonRing(presentLon, presentLat, holeCoords))) continue;
      return { staticPolygon, presentLon, presentLat, presentUnit: lonLatToUnit(presentLon, presentLat) };
    }
  }
  return null;
}
