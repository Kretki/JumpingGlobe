/**
 * Self-check for plate outlines: ring geometry, layer parsing and per-age reconstruction.
 * Run: npm run test:plates
 */

import { placeLabels } from "../rendering/labelPlacement";
import { mat4LookAt, mat4Multiply, mat4Perspective } from "../rendering/matrixMath";
import { appendRingSegments, isSeamEdge, ringCentroid } from "./outlineGeometry";
import { outlineBufferLength, reconstructOutlines } from "./outlineReconstruction";
import { parsePlateOutlines } from "./plateOutlines";
import { RotationTree } from "./rotationTree";
import { unitToLonLat } from "./sphericalCoords";

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
 * Closed square ring around a centre, counter-clockwise in lon/lat.
 *
 * Usage: fixtures.
 *
 * @param centerLon - Centre longitude.
 * @param centerLat - Centre latitude.
 * @param halfSize - Half the side length in degrees.
 * @returns Closed ring of [lon, lat] points.
 */
function squareRing(centerLon: number, centerLat: number, halfSize: number): number[][] {
  return [
    [centerLon - halfSize, centerLat - halfSize],
    [centerLon + halfSize, centerLat - halfSize],
    [centerLon + halfSize, centerLat + halfSize],
    [centerLon - halfSize, centerLat + halfSize],
    [centerLon - halfSize, centerLat - halfSize],
  ];
}

// Ring geometry: seams, densification, centroids across the antimeridian
{
  assertCheck(isSeamEdge([180, 10], [180, 20]) && isSeamEdge([-180, 10], [180, 20]), "antimeridian cut edges are seams");
  assertCheck(isSeamEdge([10, -90], [50, -90]), "edges along a pole are seams");
  assertCheck(!isSeamEdge([179, 10], [-179, 10]), "real edges crossing the antimeridian are drawn");
  const segmentValues: number[] = [];
  appendRingSegments([[0, 0], [10, 0]], segmentValues);
  assertCheck(segmentValues.length === 10 * 6, "a 10° edge is split into 1° pieces (two vertices each)");
  const midpointLonLat = unitToLonLat(segmentValues.slice(30, 33));
  assertCheck(Math.abs(midpointLonLat[0] - 5) < 1e-6 && Math.abs(midpointLonLat[1]) < 1e-6, "densified points stay on the great circle");
  const seamValues: number[] = [];
  appendRingSegments([[170, 0], [180, 0], [180, 10], [170, 10], [170, 0]], seamValues);
  assertCheck(seamValues.length === 3 * 10 * 6 && seamValues.length > 0, "the seam edge of a cut ring is skipped");

  for (const [windingName, ringCoords] of [
    ["ccw", squareRing(10, 20, 2)],
    ["cw", [...squareRing(10, 20, 2)].reverse()],
  ] as const) {
    const centroidResult = ringCentroid(ringCoords as number[][]);
    const [centroidLon, centroidLat] = unitToLonLat(centroidResult!.centroidUnit);
    assertCheck(Math.abs(centroidLon - 10) < 0.01 && Math.abs(centroidLat - 20) < 0.05, `${windingName}: centroid inside the ring`);
  }
  const dateLineRing = [[178, -2], [-178, -2], [-178, 2], [178, 2], [178, -2]];
  const dateLineLon = unitToLonLat(ringCentroid(dateLineRing)!.centroidUnit)[0];
  assertCheck(Math.abs(Math.abs(dateLineLon) - 180) < 0.01, "centroid of a ring across the antimeridian stays at 180°");
}

// Layer parsing and reconstruction: lifetimes, missing poles, one label per plate
{
  const outlineList = parsePlateOutlines({
    features: [
      { properties: { plate_id: 1, name: "Small", from_age: 500, to_age: 0 }, geometry: { type: "Polygon", coordinates: [squareRing(40, 0, 1)] } },
      { properties: { plate_id: 1, name: "Big", from_age: 500, to_age: 0 }, geometry: { type: "Polygon", coordinates: [squareRing(0, 0, 6)] } },
      { properties: { plate_id: 2, from_age: 100, to_age: 0 }, geometry: { type: "Polygon", coordinates: [squareRing(80, 0, 5)] } },
      { properties: { plate_id: 9, name: "No poles", from_age: 500, to_age: 0 }, geometry: { type: "Polygon", coordinates: [squareRing(170, 0, 5)] } },
      { properties: { name: "No plate id" }, geometry: { type: "Polygon", coordinates: [squareRing(-120, 0, 5)] } },
    ],
  });
  assertCheck(outlineList.length === 4 && outlineList[0].plateName === "Big", "outlines are parsed largest first");
  assertCheck(outlineList.some((plateOutline) => plateOutline.plateName === "Plate 2"), "unnamed plates get a fallback name");
  const rotationTree = new RotationTree({
    maxAge: 500,
    anchorPlate: 0,
    plates: { "1": [[0, 90, 0, 0, 0], [500, 90, 0, 90, 0]], "2": [[0, 90, 0, 0, 0], [500, 90, 0, 90, 0]] },
  });
  const linePositions = new Float32Array(outlineBufferLength(outlineList));
  const presentFrame = reconstructOutlines(outlineList, rotationTree, 0, linePositions);
  assertCheck(presentFrame.vertexCount * 3 === linePositions.length, "every outline is drawn at present day");
  assertCheck(presentFrame.plateLabels.length === 3, "one label per plate");
  const pastFrame = reconstructOutlines(outlineList, rotationTree, 250, linePositions);
  const pastNames = pastFrame.plateLabels.map((plateLabel) => plateLabel.labelText);
  assertCheck(!pastNames.includes("Plate 2"), "plates outside their lifetime are hidden");
  assertCheck(!pastNames.includes("No poles"), "plates without rotation poles are hidden");
  assertCheck(pastNames[0] === "Big", "the largest outline of a plate carries its label");
  const bigLabelLon = unitToLonLat(pastFrame.plateLabels[0].labelUnit)[0];
  assertCheck(Math.abs(bigLabelLon - 45) < 0.01, "labels move with their plate");

  const eyePosition = [20_000_000, 0, 0];
  const modelViewProj = mat4Multiply(mat4Perspective(Math.PI / 4, 1, 1_000, 40_000_000), mat4LookAt(eyePosition, [0, 0, 0], [0, 0, 1]));
  const labelView = { modelViewProj, eyePosition, viewportWidth: 800, viewportHeight: 800 };
  const placedLabels = placeLabels(presentFrame.plateLabels, labelView);
  const placedNames = placedLabels.map((placedLabel) => placedLabel.labelText);
  assertCheck(placedNames.includes("Big") && !placedNames.includes("No poles"), "far-side labels are not placed");
  assertCheck(Math.abs(placedLabels[0].screenX - 400) < 1 && Math.abs(placedLabels[0].screenY - 400) < 1, "a label facing the camera is centred");
}

console.log("\nAll plate outline self-checks passed.");
