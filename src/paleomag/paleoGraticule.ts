/**
 * Latitude/longitude ruler grid of a TPW spin-axis frame: equator, tropics, polar circles
 * and the 60°, 90°, 120° and 150° meridians (east and west), with degree ticks every 10°
 * and degree labels.
 */

import type { Quaternion } from "../plates/quaternionMath";
import { lonLatToUnit } from "../plates/sphericalCoords";
import type { LabelRequest } from "../rendering/labelPlacement";
import { groundPoint, SpaceLineSet, type LineColor, type SpacePoint } from "./spaceLineSet";
import { rotateUnit } from "./tpwPaths";

/** Obliquity of the ecliptic used for the tropics and polar circles (present value). */
const OBLIQUITY_DEG = 23.44;
const SAMPLE_STEP_DEG = 1;
const TICK_STEP_DEG = 10;
const LABEL_STEP_DEG = 30;
const MINOR_TICK_HALF_DEG = 0.8;
const MAJOR_TICK_HALF_DEG = 1.8;
/** Meridian ticks stop short of the poles, where east-west offsets degenerate. */
const MAX_TICK_LATITUDE_DEG = 80;
const MERIDIAN_LABEL_LATITUDES = [-60, -30, 30, 60];
const NAME_LABEL_LONGITUDE_DEG = 15;

const EQUATOR_COLOR: LineColor = [1.0, 0.86, 0.35, 0.95];
const TROPIC_COLOR: LineColor = [1.0, 0.62, 0.3, 0.9];
const POLAR_COLOR: LineColor = [0.55, 0.85, 1.0, 0.9];
const MERIDIAN_COLOR: LineColor = [0.85, 0.87, 0.92, 0.75];

/** A parallel drawn by the grid. */
type GridParallel = { latitudeDeg: number; parallelName: string; lineColor: LineColor };

export const GRID_PARALLELS: GridParallel[] = [
  { latitudeDeg: 0, parallelName: "Equator", lineColor: EQUATOR_COLOR },
  { latitudeDeg: OBLIQUITY_DEG, parallelName: "Tropic of Cancer", lineColor: TROPIC_COLOR },
  { latitudeDeg: -OBLIQUITY_DEG, parallelName: "Tropic of Capricorn", lineColor: TROPIC_COLOR },
  { latitudeDeg: 90 - OBLIQUITY_DEG, parallelName: "Arctic Circle", lineColor: POLAR_COLOR },
  { latitudeDeg: OBLIQUITY_DEG - 90, parallelName: "Antarctic Circle", lineColor: POLAR_COLOR },
];

export const GRID_MERIDIANS_DEG = [60, 90, 120, 150, -60, -90, -120, -150];

/** Grid lines (ground positions, lifted by the overlay) and their labels. */
export type GraticuleScene = { gridLines: SpaceLineSet; gridLabels: LabelRequest[] };

/**
 * Text of a longitude.
 *
 * Usage: equator labels.
 *
 * @param longitudeDeg - Longitude, -180..180.
 * @returns "0°", "180°", "60°E" or "60°W".
 */
export function longitudeText(longitudeDeg: number): string {
  if (longitudeDeg === 0 || Math.abs(longitudeDeg) === 180) return `${Math.abs(longitudeDeg)}°`;
  return `${Math.abs(longitudeDeg)}°${longitudeDeg > 0 ? "E" : "W"}`;
}

/**
 * Text of a latitude.
 *
 * Usage: meridian labels.
 *
 * @param latitudeDeg - Latitude, -90..90.
 * @returns "0°", "30°N" or "30°S".
 */
export function latitudeText(latitudeDeg: number): string {
  if (latitudeDeg === 0) return "0°";
  return `${Math.abs(latitudeDeg)}°${latitudeDeg > 0 ? "N" : "S"}`;
}

/** Places spin-frame coordinates on the globe. */
class FramePlacer {
  /**
   * Bind a frame rotation.
   *
   * Usage: one per grid build.
   *
   * @param frameQuat - Spin frame → globe rotation.
   */
  constructor(private readonly frameQuat: Quaternion) {}

  /**
   * Globe direction of a spin-frame coordinate.
   *
   * Usage: labels and line vertices.
   *
   * @param longitudeDeg - Paleolongitude.
   * @param latitudeDeg - Paleolatitude.
   * @returns Unit direction on the globe.
   */
  unitAtCoordinate(longitudeDeg: number, latitudeDeg: number) {
    return rotateUnit(this.frameQuat, lonLatToUnit(longitudeDeg, latitudeDeg));
  }

  /**
   * Ground point of a spin-frame coordinate.
   *
   * Usage: line vertices.
   *
   * @param longitudeDeg - Paleolongitude.
   * @param latitudeDeg - Paleolatitude.
   * @returns ECEF metres.
   */
  groundPointAt(longitudeDeg: number, latitudeDeg: number): SpacePoint {
    return groundPoint(this.unitAtCoordinate(longitudeDeg, latitudeDeg));
  }
}

/**
 * Add one parallel; the equator also gets longitude ticks and labels.
 *
 * Usage: buildGraticule.
 *
 * @param framePlacer - Frame.
 * @param gridParallel - Parallel.
 * @param graticuleScene - Output (mutated).
 * @returns Nothing.
 */
function addParallel(framePlacer: FramePlacer, gridParallel: GridParallel, graticuleScene: GraticuleScene): void {
  const { latitudeDeg, lineColor } = gridParallel;
  const linePoints: SpacePoint[] = [];
  for (let longitudeDeg = -180; longitudeDeg <= 180; longitudeDeg += SAMPLE_STEP_DEG) linePoints.push(framePlacer.groundPointAt(longitudeDeg, latitudeDeg));
  graticuleScene.gridLines.addPolyline(linePoints, lineColor);
  graticuleScene.gridLabels.push({ labelText: gridParallel.parallelName, labelUnit: framePlacer.unitAtCoordinate(NAME_LABEL_LONGITUDE_DEG, latitudeDeg), labelStyle: "graticule" });
  if (latitudeDeg !== 0) return;
  for (let longitudeDeg = -180 + TICK_STEP_DEG; longitudeDeg <= 180; longitudeDeg += TICK_STEP_DEG) {
    const isMajorTick = longitudeDeg % LABEL_STEP_DEG === 0;
    const tickHalf = isMajorTick ? MAJOR_TICK_HALF_DEG : MINOR_TICK_HALF_DEG;
    graticuleScene.gridLines.addSegment(framePlacer.groundPointAt(longitudeDeg, -tickHalf), framePlacer.groundPointAt(longitudeDeg, tickHalf), lineColor);
    if (isMajorTick) graticuleScene.gridLabels.push({ labelText: longitudeText(longitudeDeg), labelUnit: framePlacer.unitAtCoordinate(longitudeDeg, 0), labelStyle: "graticule" });
  }
}

/**
 * Add one pole-to-pole meridian with latitude ticks and labels.
 *
 * Usage: buildGraticule.
 *
 * @param framePlacer - Frame.
 * @param longitudeDeg - Paleolongitude of the meridian.
 * @param graticuleScene - Output (mutated).
 * @returns Nothing.
 */
function addMeridian(framePlacer: FramePlacer, longitudeDeg: number, graticuleScene: GraticuleScene): void {
  const linePoints: SpacePoint[] = [];
  for (let latitudeDeg = -90; latitudeDeg <= 90; latitudeDeg += SAMPLE_STEP_DEG) linePoints.push(framePlacer.groundPointAt(longitudeDeg, latitudeDeg));
  graticuleScene.gridLines.addPolyline(linePoints, MERIDIAN_COLOR);
  for (let latitudeDeg = -MAX_TICK_LATITUDE_DEG; latitudeDeg <= MAX_TICK_LATITUDE_DEG; latitudeDeg += TICK_STEP_DEG) {
    const tickHalf = (latitudeDeg % LABEL_STEP_DEG === 0 ? MAJOR_TICK_HALF_DEG : MINOR_TICK_HALF_DEG) / Math.cos((latitudeDeg * Math.PI) / 180);
    graticuleScene.gridLines.addSegment(framePlacer.groundPointAt(longitudeDeg - tickHalf, latitudeDeg), framePlacer.groundPointAt(longitudeDeg + tickHalf, latitudeDeg), MERIDIAN_COLOR);
  }
  for (const latitudeDeg of MERIDIAN_LABEL_LATITUDES) {
    graticuleScene.gridLabels.push({ labelText: latitudeText(latitudeDeg), labelUnit: framePlacer.unitAtCoordinate(longitudeDeg, latitudeDeg), labelStyle: "graticule" });
  }
}

/**
 * Build the ruler grid of a spin-axis frame.
 *
 * Usage: when the TPW grid layer is on and the age changed.
 *
 * @param frameQuat - Spin frame → globe rotation (TpwFrame.frameQuat).
 * @returns Lines at ground level (the overlay lifts them) and labels.
 */
export function buildGraticule(frameQuat: Quaternion): GraticuleScene {
  const framePlacer = new FramePlacer(frameQuat);
  const graticuleScene: GraticuleScene = { gridLines: new SpaceLineSet(), gridLabels: [] };
  for (const gridParallel of GRID_PARALLELS) addParallel(framePlacer, gridParallel, graticuleScene);
  for (const longitudeDeg of GRID_MERIDIANS_DEG) addMeridian(framePlacer, longitudeDeg, graticuleScene);
  return graticuleScene;
}
