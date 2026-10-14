/**
 * Self-check for plate topologies: arc intersections, section clipping, half-stage
 * rotation, ring orientation, topology resolution, plate lifetimes and boundary symbols.
 * Run: npm run test:plates
 */

import { addBoundarySymbols, emptyBoundaryGeometry, type PlateMover } from "../symbols/boundarySymbols";
import { addRingFill } from "../symbols/plateFill";
import { SymbolGeometry } from "../symbols/symbolGeometry";
import { quatFromPole, quatRotate } from "../quaternionMath";
import { RotationTree } from "../rotationTree";
import { lonLatToUnit, unitToLonLat, type UnitVector } from "../sphericalCoords";
import { intersectPolylines } from "./arcIntersection";
import { subductingPlatesOf } from "./boundaryKinematics";
import { halfStageRotation } from "./halfStageRotation";
import { eventsNear, plateDisplayName, plateEvents, plateLifetimes } from "./plateLifetimes";
import { RotationCache } from "./rotationCache";
import { clipSections } from "./sectionClipping";
import { ringContains, ringInteriorOnLeft } from "./sphericalRing";
import { parseTopologyModel } from "./topologyModel";
import { TopologyResolver } from "./topologyResolver";

/**
 * Throw when a condition fails, log it otherwise.
 *
 * Usage: every check below.
 *
 * @param condition - Checked condition.
 * @param checkName - Description printed with the result.
 * @returns Nothing.
 * @throws Error when the condition is false.
 */
function assertCheck(condition: boolean, checkName: string): void {
  if (!condition) throw new Error("FAIL: " + checkName);
  console.log("ok:", checkName);
}

/**
 * Unit vectors of [lon, lat] points.
 *
 * Usage: fixtures.
 *
 * @param lonLatPoints - Points in degrees.
 * @returns Unit vectors.
 */
function unitVectorsOf(lonLatPoints: number[][]): UnitVector[] {
  return lonLatPoints.map(([longitudeDeg, latitudeDeg]) => lonLatToUnit(longitudeDeg, latitudeDeg));
}

/**
 * Whether two lon/lat points are within a tolerance.
 *
 * Usage: position checks.
 *
 * @param actualUnit - Point to check.
 * @param expectedLon - Expected longitude.
 * @param expectedLat - Expected latitude.
 * @param toleranceDeg - Tolerance in degrees.
 * @returns True when close.
 */
function isCloseTo(actualUnit: UnitVector, expectedLon: number, expectedLat: number, toleranceDeg = 1e-6): boolean {
  const [actualLon, actualLat] = unitToLonLat(actualUnit);
  return Math.abs(actualLon - expectedLon) < toleranceDeg && Math.abs(actualLat - expectedLat) < toleranceDeg;
}

// Arc intersections and section clipping
{
  const equatorLine = unitVectorsOf([[-10, 0], [10, 0]]);
  const meridianLine = unitVectorsOf([[0, -10], [0, 10]]);
  const crossingList = intersectPolylines(equatorLine, meridianLine);
  assertCheck(crossingList.length === 1 && Math.abs(crossingList[0].firstParam - 0.5) < 1e-9, "equator and meridian cross halfway");
  assertCheck(intersectPolylines(equatorLine, unitVectorsOf([[20, -5], [20, 5]])).length === 0, "separate arcs do not cross");

  // Three overlapping lines around a triangle: each is cut where it meets its neighbours.
  const triangleSections = [unitVectorsOf([[-2, 0], [12, 0]]), unitVectorsOf([[11, -1], [-1, 11]]), unitVectorsOf([[0, 12], [0, -2]])];
  const clippedSections = clipSections(triangleSections, true);
  const ringUnits = clippedSections.flatMap((clippedSection) => clippedSection.clippedUnits);
  assertCheck(isCloseTo(ringUnits[0], 0, 0, 1e-3) && isCloseTo(clippedSections[0].clippedUnits[1], 10, 0, 0.1), "first section clipped to its neighbours");
  assertCheck(ringContains(ringUnits, lonLatToUnit(3, 3)) && !ringContains(ringUnits, lonLatToUnit(11, 11)), "clipped ring encloses the triangle only");
  assertCheck(ringInteriorOnLeft(ringUnits) && !ringInteriorOnLeft([...ringUnits].reverse()), "ring orientation follows traversal direction");
}

// Half-stage rotation: the ridge moves with half the right plate's motion
{
  const rotationTree = new RotationTree({
    maxAge: 100,
    anchorPlate: 0,
    plates: { "1": [[0, 90, 0, 0, 0], [100, 90, 0, 0, 0]], "2": [[0, 90, 0, 0, 0], [100, 90, 0, 40, 0]] },
  });
  const rotationCache = new RotationCache(rotationTree);
  const ridgeFeature = parseTopologyModel({
    features: [{ type: "MidOceanRidge", kind: "line", method: "HalfStageRotation", left: 1, right: 2, begin: 100, end: 0, coords: [0, 0, 0, 1] }],
    topologies: [],
  }).sectionFeatures[0];
  const rotatedVec: UnitVector = [0, 0, 0];
  const versionOne = halfStageRotation(rotationCache, ridgeFeature, 50)!;
  quatRotate(versionOne, 1, 0, 0, rotatedVec);
  assertCheck(isCloseTo(rotatedVec, 10, 0), "version 1: half of the 20° relative rotation");
  ridgeFeature.reconstructionMethod = "HalfStageRotationVersion3";
  ridgeFeature.importAgeMa = 50;
  quatRotate(halfStageRotation(rotationCache, ridgeFeature, 50)!, 1, 0, 0, rotatedVec);
  assertCheck(isCloseTo(rotatedVec, 0, 0), "version 3 reproduces the geometry at its import age");
  quatRotate(halfStageRotation(rotationCache, ridgeFeature, 100)!, 1, 0, 0, rotatedVec);
  assertCheck(isCloseTo(rotatedVec, 10, 0), "version 3 spreads half of the relative motion after the import age");
}

// Topology resolution: two plates split by a ridge along the 0° meridian
{
  const topologyModel = parseTopologyModel({
    features: [
      { type: "MidOceanRidge", kind: "line", method: "ByPlateId", plateId: 0, left: 1, right: 2, begin: 1e6, end: 0, coords: [0, -60, 0, 60] },
      { type: "SubductionZone", kind: "line", plateId: 0, polarity: "Left", begin: 1e6, end: 0, coords: [-30, 50, 30, 50] },
      { type: "Transform", kind: "line", plateId: 0, begin: 1e6, end: 0, coords: [30, -50, -30, -50] },
      { type: "UnclassifiedFeature", kind: "line", plateId: 0, begin: 1e6, end: 0, coords: [-20, 55, -20, -55] },
      { type: "UnclassifiedFeature", kind: "line", plateId: 0, begin: 1e6, end: 0, coords: [20, -55, 20, 55] },
    ],
    topologies: [
      { plateId: 1, name: "West AFR_001_000", begin: 1e6, end: 0, windows: [{ begin: 1e6, end: 0, sections: [[0, 1], [2, 0], [3, 1], [1, 0]] }] },
      { plateId: 2, name: "East Plate 20-0", begin: 1e6, end: 10, windows: [{ begin: 1e6, end: 0, sections: [[0, 0], [1, 0], [4, 1], [2, 0]] }] },
    ],
  });
  const resolvedTopologies = new TopologyResolver(topologyModel).resolveAt(new RotationTree({ maxAge: 100, anchorPlate: 0, plates: {} }), 20);
  assertCheck(resolvedTopologies.resolvedPlates.length === 2, "both plate polygons resolve");
  const westRing = resolvedTopologies.resolvedPlates[0].ringUnits;
  assertCheck(ringContains(westRing, lonLatToUnit(-10, 0)) && !ringContains(westRing, lonLatToUnit(10, 0)), "west plate lies west of the ridge");
  const ridgeSegment = resolvedTopologies.boundarySegments.find((boundarySegment) => boundarySegment.featureIndex === 0)!;
  assertCheck(ridgeSegment.leftPlates.includes(1) && ridgeSegment.rightPlates.includes(2), "ridge knows the plate on each side (merged from both plates)");
  // Eastward trench, polarity Left: the overriding plate is north, so both plates to the south go down
  // (the west half borders plate 1, the east half plate 2: two stretches of the same feature).
  const trenchSegments = resolvedTopologies.boundarySegments.filter((boundarySegment) => boundarySegment.featureIndex === 1);
  const downgoingPlates = trenchSegments.flatMap(subductingPlatesOf);
  assertCheck(downgoingPlates.includes(1) && downgoingPlates.includes(2), "plates on the side opposite the polarity subduct");

  const lifetimeMap = plateLifetimes(topologyModel.plateTopologies);
  assertCheck(lifetimeMap.get(1)?.appearName === "West" && lifetimeMap.get(2)?.appearName === "East Plate", "plate names lose version codes and age ranges");
  const eventList = plateEvents(lifetimeMap, 100);
  assertCheck(eventList.length === 1 && eventList[0].eventKind === "vanish" && eventList[0].eventAgeMa === 10, "only real disappearances inside the model range are events");
  assertCheck(eventsNear(eventList, 30, 25, 5).length === 1 && eventsNear(eventList, 60, 25, 5).length === 0, "events near an age");
}

// Plate names and renumbering
{
  assertCheck(plateDisplayName("Eurasia_1_0", 301) === "Eurasia" && plateDisplayName("PAC_000_000", 901) === "PAC", "underscore names are tidied");
  const renumbered = plateEvents(
    plateLifetimes([
      { plateNumber: 5, plateName: "Sea Plate", beginAgeMa: 80, endAgeMa: 40, windows: [] },
      { plateNumber: 6, plateName: "Sea Plate", beginAgeMa: 40, endAgeMa: 0, windows: [] },
    ]),
    100
  );
  assertCheck(renumbered.length === 1 && renumbered[0].eventKind === "appear" && renumbered[0].eventAgeMa === 80, "a plate continued under a new id is not an event");
}

// Symbols: teeth on the overriding side, spreading arrows away from the ridge, fills on the sphere
{
  const stillMover: PlateMover = (_, pointUnit) => pointUnit;
  const boundaryGeometry = emptyBoundaryGeometry();
  const trenchFeature = parseTopologyModel({ features: [{ type: "SubductionZone", kind: "line", polarity: "Left", coords: [0, 0, 20, 0] }], topologies: [] }).sectionFeatures[0];
  addBoundarySymbols({ featureIndex: 0, sectionFeature: trenchFeature, lineUnits: unitVectorsOf([[0, 0], [20, 0]]), leftPlates: [], rightPlates: [] }, stillMover, 0.02, boundaryGeometry);
  const toothValues = boundaryGeometry.subduction.triangleValues;
  assertCheck(toothValues.length > 0 && Math.max(...toothValues.filter((_, valueIdx) => valueIdx % 3 === 2)) > 0.01, "teeth point to the overriding (left = north) side of an eastward trench");

  const spinningMover: PlateMover = (plateNumber, pointUnit) => {
    const movedUnit: UnitVector = [0, 0, 0];
    quatRotate(quatFromPole(90, 0, plateNumber === 2 ? -1 : 1), pointUnit[0], pointUnit[1], pointUnit[2], movedUnit);
    return movedUnit;
  };
  const ridgeGeometry = emptyBoundaryGeometry();
  const ridgeFeature = parseTopologyModel({ features: [{ type: "MidOceanRidge", kind: "line", coords: [0, -10, 0, 10] }], topologies: [] }).sectionFeatures[0];
  addBoundarySymbols({ featureIndex: 0, sectionFeature: ridgeFeature, lineUnits: unitVectorsOf([[0, -10], [0, 10]]), leftPlates: [1], rightPlates: [2] }, spinningMover, 0.02, ridgeGeometry);
  assertCheck(ridgeGeometry.divergent.lineValues.length > 12, "ridges get spreading arrows");

  const fillGeometry = new SymbolGeometry();
  addRingFill(unitVectorsOf([[-30, -20], [30, -20], [30, 20], [-30, 20]]), fillGeometry);
  const fillValues = fillGeometry.triangleValues;
  let maxRadiusError = 0;
  for (let valueIdx = 0; valueIdx < fillValues.length; valueIdx += 3) maxRadiusError = Math.max(maxRadiusError, Math.abs(Math.hypot(fillValues[valueIdx], fillValues[valueIdx + 1], fillValues[valueIdx + 2]) - 1));
  assertCheck(fillValues.length / 9 > 20 && maxRadiusError < 1e-9, "large plate fills are refined and stay on the sphere");
}

console.log("\nAll plate topology self-checks passed.");
