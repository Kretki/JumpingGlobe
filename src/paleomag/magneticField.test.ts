/**
 * Self-check for the magnetic layers built from PINT sites: site validation, age weighting,
 * plate rotation of VGPs, pole clustering, field sources, field-line tracing and the scene.
 * Run: npm run test:paleomag
 */

import { quatFromPole, quatRotate } from "../plates/quaternionMath";
import { RotationTree } from "../plates/rotationTree";
import { lonLatToUnit, unitToLonLat, type UnitVector } from "../plates/sphericalCoords";
import { RotationCache } from "../plates/topology/rotationCache";
import { dotProduct } from "../plates/unitVectorMath";
import { addFieldLines, LINES_PER_LAYER, linesPerSource } from "./fieldLines";
import { buildFieldCharges, fieldAtPoint } from "./fieldSources";
import { traceFieldLine } from "./fieldTracer";
import { magneticFieldAt, magneticFieldNote } from "./magneticField";
import { buildPaleoScene } from "./paleoScene";
import { parsePintSites } from "./pintSites";
import { clusterPoles } from "./poleClusters";
import type { SiteSettings } from "./siteSettings";
import { sitesAtAge, type WindowSite } from "./siteWindow";
import { SpaceLineSet } from "./spaceLineSet";

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
 * A window site with a VGP at a position.
 *
 * Usage: clustering checks.
 *
 * @param longitudeDeg - VGP longitude.
 * @param latitudeDeg - VGP latitude.
 * @param momentE22 - Moment (NaN = unknown).
 * @returns The site with weight 1.
 */
function vgpSiteAt(longitudeDeg: number, latitudeDeg: number, momentE22: number): WindowSite {
  return { siteIndex: 0, ageWeight: 1, ageCloseness: 1, polarity: latitudeDeg > 0 ? "N" : "R", momentE22, vgpUnit: lonLatToUnit(longitudeDeg, latitudeDeg) };
}

const testSettings: SiteSettings = { minWindowMyr: 1, maxWindowMyr: 10, clusterRadiusDeg: 30, maxFieldSources: 4, minPoleShare: 0.05, minSourceShare: 0.1, magnetDepth: 0.85 };

/** Plate 7 is rotated 30° about the x axis at 1000 Ma (3° at 100 Ma). */
const rotationTree = new RotationTree({ maxAge: 1000, anchorPlate: 0, plates: { "7": [[0, 0, 0, 0, 0], [1000, 0, 0, 30, 0]] } });

const pintSites = parsePintSites({
  siteName: ["precise", "loose", "old", "no plate"],
  siteLat: [10, 10, 10, 10],
  siteLon: [0, 0, 0, 0],
  ageMa: [100, 100, 300, 100],
  ageError: [0.5, 5, 1, 0.5],
  momentE22: [8, null, 4, 6],
  vgpLat: [90, 85, 90, 90],
  vgpLon: [0, 0, 0, 0],
  plateId: [7, 7, 7, null],
  polarity: "NNRT",
})!;

// Site validation
assertCheck(pintSites.siteCount === 4 && pintSites.polarity.join("") === "NNRT", "sites and polarity letters are read");
assertCheck(Number.isNaN(pintSites.momentE22[1]) && pintSites.plateNumber[3] === -1, "missing moment and plate are marked");
assertCheck(parsePintSites({ ageMa: [1], polarity: "NN" }) === null, "columns of different length are rejected");

// Window: precise sites weigh more, VGPs move with their plate, sites far in time and without plate are left out
{
  const windowSites = sitesAtAge(pintSites, new RotationCache(rotationTree), 100, testSettings);
  assertCheck(windowSites.length === 3 && !windowSites.some((windowSite) => windowSite.siteIndex === 2), "the 300 Ma site is outside the 100 Ma window");
  assertCheck(windowSites[0].ageWeight > windowSites[1].ageWeight * 4, "a loosely dated site weighs less");
  const expectedPole: UnitVector = [0, 0, 0];
  quatRotate(quatFromPole(0, 0, 3), 0, 0, 1, expectedPole);
  assertCheck(dotProduct(windowSites[0].vgpUnit!, expectedPole) > 0.999999, "VGP is rotated with the site's plate");
  assertCheck(windowSites[2].vgpUnit === null, "a site without plate has no VGP in the past");
}

// Clustering: scattered VGPs near the pole merge; an equatorial group is a second pole
{
  const northSites = [vgpSiteAt(0, 75, 8), vgpSiteAt(180, 75, 8), vgpSiteAt(90, 80, 8), vgpSiteAt(-90, 80, 8), vgpSiteAt(0, 88, NaN)];
  const equatorSites = [vgpSiteAt(40, 0, 3), vgpSiteAt(45, 5, 3)];
  const magneticPoles = clusterPoles([...northSites, ...equatorSites], testSettings);
  assertCheck(magneticPoles.length === 2, "scatter around the pole merges into one pole, the equatorial group is another");
  assertCheck(unitToLonLat(magneticPoles[0].northUnit)[1] > 85 && Math.abs(magneticPoles[0].weightShare - 5 / 7) < 1e-9, "main pole and its share");
  assertCheck(magneticPoles[0].momentE22 === 8 && magneticPoles[1].momentE22 === 3, "pole strength is the mean moment of its sites");
  assertCheck(clusterPoles([...northSites, vgpSiteAt(40, 0, 3)], { ...testSettings, minPoleShare: 0.2 }).length === 1, "poles below the minimum share are dropped");
}

// Sources: a pole is a pair of opposite charges, negative under the north pole
{
  const magneticPoles = clusterPoles([vgpSiteAt(0, 90, 8)], testSettings);
  const fieldCharges = buildFieldCharges(magneticPoles, testSettings);
  assertCheck(fieldCharges.length === 2 && fieldCharges[0].chargeStrength === -8 && fieldCharges[1].chargeStrength === 8, "charge pair sized by moment");
  const fieldVector: UnitVector = [0, 0, 0];
  fieldAtPoint(fieldCharges, 0, 0, 1.2, fieldVector);
  assertCheck(fieldVector[2] < 0, "the field enters the ground at the geomagnetic north pole");
  const tracedLine = traceFieldLine(fieldCharges, lonLatToUnit(0, -70))!;
  const endLatitude = unitToLonLat(tracedLine.linePoints[tracedLine.linePoints.length - 1])[1];
  assertCheck(tracedLine.returnsToGround && endLatitude > 60, "a line leaving near the south pole returns near the north pole");
  assertCheck(traceFieldLine(fieldCharges, lonLatToUnit(0, 70)) === null, "no line starts where the field goes into the ground");
  const spaceLineSet = new SpaceLineSet();
  assertCheck(addFieldLines(spaceLineSet, fieldCharges, 2) === 2 * LINES_PER_LAYER, "one source draws 24 lines per layer");
  const twoSources = [...fieldCharges, { chargePosition: [0.85, 0, 0] as UnitVector, chargeStrength: 2, groundUnit: [1, 0, 0] as UnitVector }];
  assertCheck(linesPerSource(twoSources.filter((fieldCharge) => fieldCharge.chargeStrength > 0)).join() === "19,5", "lines are shared out by source strength");
}

// Whole field and scene
{
  const magneticField = magneticFieldAt(pintSites, new RotationCache(rotationTree), 100, testSettings);
  assertCheck(magneticField.magneticPoles.length === 1 && Math.abs(magneticField.windowMomentE22 - 7) < 1e-9, "field of an age: one pole, weighted window moment");
  assertCheck(magneticFieldNote(magneticField, 100).startsWith("1 pole · field 7.0×10²² A·m² · 2 sites (N 2)"), "field note");
  assertCheck(magneticFieldNote(magneticFieldAt(pintSites, new RotationCache(rotationTree), 2000, testSettings), 2000) === "No PINT site near 2000 Ma", "note without sites");
  const allLayers = { showSpinAxis: true, showPaleoGrid: true, showMagneticPoles: true, showFieldLines: true, tpwFrameKey: "", fieldShellCount: 1 };
  const magneticScene = buildPaleoScene({ tpwFrame: null, magneticField, layerChoice: allLayers });
  assertCheck(magneticScene.lineGroups.has("groundMarks") && magneticScene.lineGroups.has("spaceLines") && !magneticScene.lineGroups.has("paleoGrid"), "magnetic data fills its groups only");
  assertCheck(magneticScene.fixedLabels.some((labelRequest) => labelRequest.labelText.startsWith("N1 · 8.0×10²² A·m² · 2 sites")), "pole label shows its strength");
}

console.log("All magnetic-field self-checks passed.");
