/**
 * Wiring of the optional plate layers drawn over the globe: the static-polygon
 * outlines with plate names, the tectonic layers (boundaries, motion, subducting
 * plates, events), the paleomagnetic layers (TPW poles and grid, magnetic poles and
 * field lines) and the shared label board.
 */

import type { RotationTree } from "../plates/rotationTree";
import type { LabelView } from "../rendering/labelPlacement";
import type { Matrix4x4 } from "../rendering/matrixMath";
import type { PaleoGroup } from "../paleomag/paleoScene";
import { PlateOutlineOverlay } from "../rendering/plateOutlineOverlay";
import { SpaceLineOverlay } from "../rendering/spaceLineOverlay";
import { TectonicOverlay } from "../rendering/tectonicOverlay";
import {
  createFieldStrengthChart,
  createPaleoLayerControls,
  createPlateDisplayControls,
  createPlateEventsPanel,
  createPlateLabelLayer,
  createTectonicLayerControls,
} from "../ui/panelFactories";
import type { AgeSource } from "../ui/timelineControl";
import { fetchPaleoMagData, fetchPlateOutlines, fetchPlateTopologies } from "./globeApi";
import { LabelBoard } from "./labelBoard";
import { PaleoLayersController } from "./paleoLayersController";
import { PlateOutlineController } from "./plateOutlineController";
import { TectonicsController } from "./tectonicsController";

/** Where the plate layers get the rotation model and their files (PlateLayerTracker). */
export interface PlateLayerSource {
  readonly rotationTree: RotationTree | null;
  readonly outlinesFile: string | null;
  readonly staticFile: string | null;
  readonly topologyFile: string | null;
  readonly topologyStatus: string;
  readonly topologyDetail: string;
}

/** GL resources the overlays draw with (GlobeRenderer). */
export interface GlobeProgramSource {
  readonly globeProgram: WebGLProgram;
  readonly normalAttribute: number;
}

export type PlateLayers = {
  outlineOverlay: PlateOutlineOverlay;
  plateOutlines: PlateOutlineController;
  tectonicOverlay: TectonicOverlay;
  tectonics: TectonicsController;
  paleoOverlay: SpaceLineOverlay<PaleoGroup>;
  paleoLayers: PaleoLayersController;
  labelBoard: LabelBoard;
};

/** Drawing order of the paleomagnetic line groups. */
const PALEO_GROUP_ORDER: readonly PaleoGroup[] = ["groundMarks", "paleoGrid", "spaceLines"];

/**
 * Create the paleomagnetic layers with their controls.
 *
 * Usage: createPlateLayers.
 *
 * @param paleoOverlay - Overlay the layers draw into.
 * @param layerSource - Rotation model.
 * @param ageSource - Displayed age.
 * @param onStatusChange - Refreshes the timeline status line.
 * @returns The controller.
 */
function createPaleoLayers(
  paleoOverlay: SpaceLineOverlay<PaleoGroup>,
  layerSource: PlateLayerSource,
  ageSource: AgeSource,
  onStatusChange: () => void
): PaleoLayersController {
  let paleoLayers: PaleoLayersController | null = null;
  const paleoControls = createPaleoLayerControls(() => paleoLayers?.handleLayerChange());
  paleoLayers = new PaleoLayersController({
    rotationSource: layerSource,
    ageSource,
    layerChoice: paleoControls,
    availabilitySink: paleoControls,
    lineSink: paleoOverlay,
    strengthSink: createFieldStrengthChart(),
    loadData: fetchPaleoMagData,
    onStatusChange,
  });
  return paleoLayers;
}

/**
 * Create the outline and tectonic layers with their controls.
 *
 * Usage: once at start-up.
 *
 * @param glContext - WebGL context.
 * @param globeProgramSource - Globe program restored after each overlay.
 * @param layerSource - Rotation model and layer files.
 * @param ageSource - Displayed age.
 * @param onStatusChange - Refreshes the timeline status line.
 * @returns The layers.
 */
export function createPlateLayers(
  glContext: WebGLRenderingContext,
  globeProgramSource: GlobeProgramSource,
  layerSource: PlateLayerSource,
  ageSource: AgeSource,
  onStatusChange: () => void
): PlateLayers {
  const { globeProgram, normalAttribute } = globeProgramSource;
  const outlineOverlay = new PlateOutlineOverlay(glContext, globeProgram, normalAttribute);
  const tectonicOverlay = new TectonicOverlay(glContext, globeProgram, normalAttribute);
  let plateOutlines: PlateOutlineController | null = null;
  let tectonics: TectonicsController | null = null;
  plateOutlines = new PlateOutlineController({
    outlineSource: layerSource,
    ageSource,
    displayChoice: createPlateDisplayControls(() => plateOutlines?.handleDisplayChange()),
    lineSink: outlineOverlay,
    loadOutlines: fetchPlateOutlines,
    onStatusChange,
  });
  tectonics = new TectonicsController({
    topologySource: layerSource,
    ageSource,
    layerChoice: createTectonicLayerControls(() => tectonics?.handleLayerChange()),
    sceneSink: tectonicOverlay,
    eventsSink: createPlateEventsPanel(),
    loadTopologies: fetchPlateTopologies,
    onStatusChange,
  });
  const paleoOverlay = new SpaceLineOverlay<PaleoGroup>(glContext, globeProgram, normalAttribute, PALEO_GROUP_ORDER);
  const paleoLayers = createPaleoLayers(paleoOverlay, layerSource, ageSource, onStatusChange);
  const labelBoard = new LabelBoard([paleoLayers, tectonics, plateOutlines], createPlateLabelLayer());
  return { outlineOverlay, plateOutlines, tectonicOverlay, tectonics, paleoOverlay, paleoLayers, labelBoard };
}

/**
 * Bring every plate layer up to date for this frame.
 *
 * Usage: frame loop, before drawing.
 *
 * @param plateLayers - Layers.
 * @param cameraHeightM - Camera height.
 * @returns Nothing.
 */
export function updatePlateLayers(plateLayers: PlateLayers, cameraHeightM: number): void {
  plateLayers.plateOutlines.updateFrame();
  plateLayers.tectonics.updateFrame(cameraHeightM);
  plateLayers.paleoLayers.updateFrame(cameraHeightM);
}

/**
 * Draw the plate layers and their labels.
 *
 * Usage: frame loop, after the globe and before the selection overlay.
 *
 * @param plateLayers - Layers.
 * @param modelViewProj - Camera matrix.
 * @param cameraHeightM - Camera height.
 * @param labelView - Camera and viewport for label placement.
 * @returns Nothing.
 */
export function drawPlateLayers(plateLayers: PlateLayers, modelViewProj: Matrix4x4, cameraHeightM: number, labelView: LabelView): void {
  if (plateLayers.plateOutlines.isShowing) plateLayers.outlineOverlay.drawOutlines(modelViewProj, cameraHeightM);
  if (plateLayers.tectonics.isShowing) plateLayers.tectonicOverlay.drawScene(modelViewProj, cameraHeightM);
  if (plateLayers.paleoLayers.isShowing) plateLayers.paleoOverlay.drawLines(modelViewProj);
  plateLayers.labelBoard.renderFrame(labelView);
}

/**
 * Status notes of the plate layers.
 *
 * Usage: timeline status line.
 *
 * @param plateLayers - Layers.
 * @returns Notes joined by " · " ("" when there is nothing to report).
 */
export function plateLayersNote(plateLayers: PlateLayers): string {
  return [plateLayers.plateOutlines.statusNote, plateLayers.tectonics.statusNote, plateLayers.paleoLayers.statusNote].filter(Boolean).join(" · ");
}
