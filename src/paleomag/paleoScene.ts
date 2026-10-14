/** Assemble the paleomagnetic overlay for one age from the ticked layers. */

import type { LabelRequest } from "../rendering/labelPlacement";
import { addFieldLines } from "./fieldLines";
import { buildGraticule } from "./paleoGraticule";
import { addMagneticPoles, addSpinAxisRods, addTpwTrack } from "./poleMarkers";
import { meanPoleAxis, type PlacedPole } from "./poleSelection";
import { SpaceLineSet } from "./spaceLineSet";
import type { TpwFrame } from "./tpwPaths";

/** Which paleomagnetic layers are ticked (PaleoLayerControls). */
export interface PaleoLayerChoice {
  readonly showSpinAxis: boolean;
  readonly showPaleoGrid: boolean;
  readonly showMagneticPoles: boolean;
  readonly showFieldLines: boolean;
  /** Key of the chosen TPW path (mantle reference frame). */
  readonly tpwFrameKey: string;
  /** Number of field-line shells, 1..3. */
  readonly fieldShellCount: number;
}

/**
 * Line groups, by how they are lifted: the grid floats (gridLiftScale), pole markers sit
 * on the ground (groundLiftScale), rods and field lines are drawn where they are.
 */
export type PaleoGroup = "paleoGrid" | "groundMarks" | "spaceLines";

export type PaleoScene = {
  lineGroups: Map<PaleoGroup, SpaceLineSet>;
  /** Grid labels; their lift follows the grid's. */
  gridLabels: LabelRequest[];
  /** Other labels, with their own lift. */
  fixedLabels: LabelRequest[];
};

export type PaleoSceneInput = {
  /** Spin axis of the chosen TPW path at the displayed age, or null without TPW data. */
  tpwFrame: TpwFrame | null;
  /** Paleomagnetic poles of the displayed age (empty without data). */
  placedPoles: PlacedPole[];
  layerChoice: PaleoLayerChoice;
};

/**
 * Build the overlay geometry and labels.
 *
 * Usage: whenever the age, the available data or the layer choice changed. Layers whose
 * data is missing for the age are left out even when ticked.
 *
 * @param sceneInput - Data of the age and the layer choice.
 * @returns Non-empty line groups and the labels.
 */
export function buildPaleoScene(sceneInput: PaleoSceneInput): PaleoScene {
  const { tpwFrame, placedPoles, layerChoice } = sceneInput;
  const paleoScene: PaleoScene = { lineGroups: new Map(), gridLabels: [], fixedLabels: [] };
  const groundMarks = new SpaceLineSet();
  const spaceLines = new SpaceLineSet();
  if (tpwFrame && layerChoice.showPaleoGrid) {
    const graticuleScene = buildGraticule(tpwFrame.frameQuat);
    paleoScene.lineGroups.set("paleoGrid", graticuleScene.gridLines);
    paleoScene.gridLabels = graticuleScene.gridLabels;
  }
  if (tpwFrame && layerChoice.showSpinAxis) {
    addSpinAxisRods(spaceLines, tpwFrame, paleoScene.fixedLabels);
    addTpwTrack(groundMarks, tpwFrame);
  }
  if (placedPoles.length && layerChoice.showMagneticPoles) addMagneticPoles(groundMarks, placedPoles, paleoScene.fixedLabels);
  const dipoleAxis = layerChoice.showFieldLines ? meanPoleAxis(placedPoles) : null;
  if (dipoleAxis) addFieldLines(spaceLines, dipoleAxis, layerChoice.fieldShellCount, paleoScene.fixedLabels);
  if (groundMarks.vertexCount) paleoScene.lineGroups.set("groundMarks", groundMarks);
  if (spaceLines.vertexCount) paleoScene.lineGroups.set("spaceLines", spaceLines);
  return paleoScene;
}
