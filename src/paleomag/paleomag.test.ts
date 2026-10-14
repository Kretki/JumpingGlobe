/**
 * Self-check for the TPW layers: data validation, TPW paths and rates, the TPW grid,
 * grid lift and scene assembly (the magnetic field is checked in magneticField.test.ts).
 * Run: npm run test:paleomag
 */

import { quatFromPole, quatRotate } from "../plates/quaternionMath";
import { unitToLonLat, type UnitVector } from "../plates/sphericalCoords";
import { dotProduct } from "../plates/unitVectorMath";
import { GRID_GROUND_HEIGHT_M, gridLiftScale } from "./gridLift";
import { buildGraticule, latitudeText, longitudeText } from "./paleoGraticule";
import { parsePaleoMagData } from "./paleomagModel";
import { buildPaleoScene, type PaleoLayerChoice } from "./paleoScene";
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

const paleoData = parsePaleoMagData({
  sites: null,
  platesReady: true,
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
assertCheck(paleoData.pintSites === null && paleoData.tpwPaths.length === 1, "missing sites are allowed and invalid paths are dropped");
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

// Grid lift follows the zoom
{
  assertCheck(gridLiftScale(GRID_GROUND_HEIGHT_M / 2) < 1.001, "grid lies on the ground below the configured height");
  assertCheck(gridLiftScale(GRID_GROUND_HEIGHT_M * 3) > 1.01, "grid floats above the ground when far away");
  assertCheck(gridLiftScale(GRID_GROUND_HEIGHT_M * 1.5) < gridLiftScale(GRID_GROUND_HEIGHT_M * 3), "lift grows with height");
}

// Scene: ticked layers without data draw nothing
{
  const allLayers: PaleoLayerChoice = { showSpinAxis: true, showPaleoGrid: true, showMagneticPoles: true, showFieldLines: true, tpwFrameKey: "TEST", fieldShellCount: 3 };
  assertCheck(buildPaleoScene({ tpwFrame: null, magneticField: null, layerChoice: allLayers }).lineGroups.size === 0, "no data, no lines");
  const tpwScene = buildPaleoScene({ tpwFrame: new TpwPaths(paleoData.tpwPaths).frameAtAge("TEST", 5), magneticField: null, layerChoice: allLayers });
  assertCheck(["paleoGrid", "groundMarks", "spaceLines"].every((groupKey) => tpwScene.lineGroups.has(groupKey as never)), "TPW data fills every group");
}

console.log("All paleomagnetic self-checks passed.");
