/**
 * Self-check for the paleomagnetic layers: data validation, TPW paths, pole placement,
 * the TPW grid, dipole field lines, grid lift and scene assembly.
 * Run: npm run test:paleomag
 */

import { WGS84_SEMI_MAJOR } from "../geodesy/wgs84Ellipsoid";
import { quatFromPole, quatRotate } from "../plates/quaternionMath";
import { RotationTree } from "../plates/rotationTree";
import { unitToLonLat, type UnitVector } from "../plates/sphericalCoords";
import { RotationCache } from "../plates/topology/rotationCache";
import { dotProduct } from "../plates/unitVectorMath";
import { FIELD_SHELL_RADII, LINES_PER_SHELL, SAMPLES_PER_LINE, addFieldLines } from "./fieldLines";
import { GRID_GROUND_HEIGHT_M, gridLiftScale } from "./gridLift";
import { profileForApex } from "./magnetProfile";
import { buildGraticule, latitudeText, longitudeText } from "./paleoGraticule";
import { parsePaleoMagData } from "./paleomagModel";
import { buildPaleoScene, type PaleoLayerChoice } from "./paleoScene";
import { meanPoleAxis, polesAtAge } from "./poleSelection";
import { SpaceLineSet } from "./spaceLineSet";
import { interpolateSeries, rotateUnit, TpwPaths, tpwRateNote } from "./tpwPaths";

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
 * Length of an ECEF vector in Earth radii.
 *
 * Usage: field-line checks.
 *
 * @param positionValues - Flat xyz list.
 * @param vertexIndex - Vertex.
 * @returns |p| / a.
 */
function radiusOf(positionValues: number[], vertexIndex: number): number {
  const valueIdx = vertexIndex * 3;
  return Math.hypot(positionValues[valueIdx], positionValues[valueIdx + 1], positionValues[valueIdx + 2]) / WGS84_SEMI_MAJOR;
}

/** Plate 7 is rotated 30° about the x axis at every age; plate 8 is fixed. */
const rotationTree = new RotationTree({
  maxAge: 1000,
  anchorPlate: 0,
  plates: { "7": [[0, 0, 0, 0, 0], [1000, 0, 0, 30, 0]], "8": [[0, 90, 0, 0, 0], [1000, 90, 0, 0, 0]] },
});

const paleoData = parsePaleoMagData({
  poles: [
    { poleName: "A", block: "Seven", plateId: 7, youngAgeMa: 100, oldAgeMa: 120, latitudeDeg: 90, longitudeDeg: 0, confidenceDeg: 5 },
    { poleName: "B", block: "Unmapped", plateId: null, youngAgeMa: 100, oldAgeMa: 120, latitudeDeg: 80, longitudeDeg: 0 },
    { poleName: "bad", plateId: 7, youngAgeMa: 100, oldAgeMa: 120, latitudeDeg: 95, longitudeDeg: 0 },
  ],
  tpwPaths: [
    {
      frameKey: "TEST",
      frameLabel: "Test frame",
      points: [
        { ageMa: 10, longitudeDeg: 0, latitudeDeg: 80, confidenceDeg: 2 },
        { ageMa: 0, longitudeDeg: 0, latitudeDeg: 90, confidenceDeg: 0 },
        { ageMa: 20, longitudeDeg: 0, latitudeDeg: 95 },
      ],
    },
    { frameKey: "", points: [{ ageMa: 0, longitudeDeg: 0, latitudeDeg: 90 }] },
  ],
  tpwRates: [
    { ageMa: 0, rateDegPerMyr: 0.2, rateLowDegPerMyr: 0.1, rateHighDegPerMyr: 0.3 },
    { ageMa: 10, rateDegPerMyr: 0.4, rateLowDegPerMyr: 0.3, rateHighDegPerMyr: 0.5 },
  ],
  tpwNetAngles: [
    { ageMa: 0, rateDegPerMyr: 0, netAngleDeg: 0 },
    { ageMa: 10, rateDegPerMyr: 0.8, netAngleDeg: null },
    { ageMa: 20, rateDegPerMyr: null, netAngleDeg: 8 },
  ],
});

// Validation
assertCheck(paleoData.paleoPoles.length === 2 && paleoData.tpwPaths.length === 1, "invalid poles and paths are dropped");
assertCheck(paleoData.paleoPoles[0].confidenceDeg === 5 && paleoData.paleoPoles[1].confidenceDeg === null, "confidence radius is optional");
assertCheck(paleoData.tpwPaths[0].pathPoints.length === 2 && paleoData.tpwPaths[0].pathPoints[0].ageMa === 0, "path points are validated and sorted by age");

// TPW paths: the spin axis is interpolated along the great circle between path poles
{
  const tpwPaths = new TpwPaths(paleoData.tpwPaths);
  assertCheck(tpwPaths.frameOptions.length === 1 && tpwPaths.frameOptions[0].frameLabel === "Test frame", "frame options for the dropdown");
  assertCheck(tpwPaths.frameAtAge("TEST", 11) === null && tpwPaths.frameAtAge("OTHER", 5) === null, "no TPW pole outside the path or for an unknown frame");
  const presentFrame = tpwPaths.frameAtAge("TEST", 0)!;
  assertCheck(presentFrame.spinAxisUnit[2] > 0.999999, "present-day spin axis is the north pole");
  const middleFrame = tpwPaths.frameAtAge("TEST", 5)!;
  assertCheck(Math.abs(unitToLonLat(middleFrame.spinAxisUnit)[1] - 85) < 1e-9, "spin axis is interpolated between path poles");
  assertCheck(middleFrame.confidenceDeg === 1 && presentFrame.confidenceDeg === 0, "confidence radius is interpolated");
  const gridNorth = rotateUnit(middleFrame.frameQuat, [0, 0, 1]);
  assertCheck(dotProduct(gridNorth, middleFrame.spinAxisUnit) > 0.999999, "TPW grid is centred on the spin axis");
  const coveredSpan = tpwPaths.coveredSpan("TEST");
  assertCheck(coveredSpan !== null && coveredSpan[0] === 0 && coveredSpan[1] === 10, "covered TPW span");
  assertCheck(interpolateSeries([0, 10, 20], [0, null, 8], 15) === 6 && interpolateSeries([0, 10], [1, 2], 11) === null, "series interpolation skips gaps");
  assertCheck(tpwRateNote(paleoData.tpwRates, paleoData.tpwNetAngles, 5) === "PW rate 0.30 (0.20–0.40)°/Myr · T14: 0.40°/Myr, net TPW 2.0°", "TPW rate note");
  assertCheck(tpwRateNote([], [], 5) === "", "no rate note without data");
}

// Poles move with their plate; unmapped blocks are skipped
{
  const rotationCache = new RotationCache(rotationTree);
  const placedPoles = polesAtAge(paleoData.paleoPoles, rotationCache, 110);
  assertCheck(placedPoles.length === 1 && placedPoles[0].paleoPole.poleName === "A", "only poles of mapped plates inside their window are placed");
  const expectedNorth: UnitVector = [0, 0, 0];
  quatRotate(quatFromPole(0, 0, 3.3), 0, 0, 1, expectedNorth);
  assertCheck(dotProduct(placedPoles[0].northUnit, expectedNorth) > 0.999999, "pole is rotated with its plate at the displayed age");
  assertCheck(polesAtAge(paleoData.paleoPoles, rotationCache, 130).length === 0, "no poles outside their window");
  assertCheck(meanPoleAxis([]) === null && meanPoleAxis(placedPoles) !== null, "mean axis needs a pole");
}

// TPW grid
{
  const frameQuat = quatFromPole(10, 20, 35);
  const spinAxis: UnitVector = [0, 0, 0];
  quatRotate(frameQuat, 0, 0, 1, spinAxis);
  const graticuleScene = buildGraticule(frameQuat);
  const equatorLabels = graticuleScene.gridLabels.filter((gridLabel) => /^\d+°[EW]?$/.test(gridLabel.labelText));
  assertCheck(equatorLabels.length === 12, "equator carries a longitude label every 30°");
  assertCheck(equatorLabels.every((gridLabel) => Math.abs(dotProduct(gridLabel.labelUnit, spinAxis)) < 1e-9), "equator labels lie on the frame's equator");
  assertCheck(graticuleScene.gridLabels.some((gridLabel) => gridLabel.labelText === "Arctic Circle"), "polar circles are named");
  assertCheck(longitudeText(-60) === "60°W" && longitudeText(180) === "180°" && latitudeText(-30) === "30°S", "degree texts");
}

// Field lines: 24 per shell, leaving the ground in a tube around the north pole, red to blue
{
  const spaceLineSet = new SpaceLineSet();
  const labelRequests: never[] = [];
  addFieldLines(spaceLineSet, [0, 0, 1], 2, labelRequests);
  const lineVertices = SAMPLES_PER_LINE * 2 + 4;
  const tubeVertices = 2 * 2 * 48;
  assertCheck(spaceLineSet.vertexCount === 2 * (LINES_PER_SHELL * lineVertices + tubeVertices) + 4, "two shells of 24 lines, their tube mouths and the magnet axis");
  assertCheck(Math.abs(radiusOf(spaceLineSet.positionValues, 0) - 1) < 1e-6, "field line starts on the ground");
  assertCheck(Math.abs(radiusOf(spaceLineSet.positionValues, SAMPLES_PER_LINE) - FIELD_SHELL_RADII[0]) < 0.01, "field line apex is at the shell radius");
  const footColatitude = profileForApex(FIELD_SHELL_RADII[0], SAMPLES_PER_LINE).footColatitudeRad;
  assertCheck(footColatitude < Math.asin(Math.sqrt(1 / FIELD_SHELL_RADII[0])) - 0.2, "lines leave closer to the pole than a central dipole's");
  assertCheck(profileForApex(FIELD_SHELL_RADII[1], SAMPLES_PER_LINE).footColatitudeRad < footColatitude, "outer layers leave closer to the pole");
  const lastVertex = SAMPLES_PER_LINE * 2 - 1;
  assertCheck(spaceLineSet.positionValues[lastVertex * 3 + 2] < 0 && Math.abs(radiusOf(spaceLineSet.positionValues, lastVertex) - 1) < 1e-6, "field line ends on the ground in the south");
  assertCheck(spaceLineSet.colorValues[0] > spaceLineSet.colorValues[2] && spaceLineSet.colorValues[lastVertex * 4 + 2] > spaceLineSet.colorValues[lastVertex * 4], "field line runs from red to blue");
}

// Grid lift follows the zoom
{
  assertCheck(gridLiftScale(GRID_GROUND_HEIGHT_M / 2) < 1.001, "grid lies on the ground below the configured height");
  assertCheck(gridLiftScale(GRID_GROUND_HEIGHT_M * 3) > 1.01, "grid floats above the ground when far away");
  assertCheck(gridLiftScale(GRID_GROUND_HEIGHT_M * 1.5) < gridLiftScale(GRID_GROUND_HEIGHT_M * 3), "lift grows with height");
}

// Scene: ticked layers without data draw nothing
{
  const allLayers: PaleoLayerChoice = { showSpinAxis: true, showPaleoGrid: true, showMagneticPoles: true, showFieldLines: true, tpwFrameKey: "TEST", fieldShellCount: 3 };
  assertCheck(buildPaleoScene({ tpwFrame: null, placedPoles: [], layerChoice: allLayers }).lineGroups.size === 0, "no data, no lines");
  const rotationCache = new RotationCache(rotationTree);
  const fullScene = buildPaleoScene({
    tpwFrame: new TpwPaths(paleoData.tpwPaths).frameAtAge("TEST", 5),
    placedPoles: polesAtAge(paleoData.paleoPoles, rotationCache, 110),
    layerChoice: allLayers,
  });
  assertCheck(["paleoGrid", "groundMarks", "spaceLines"].every((groupKey) => fullScene.lineGroups.has(groupKey as never)), "every group is filled with data");
}

console.log("All paleomagnetic self-checks passed.");
