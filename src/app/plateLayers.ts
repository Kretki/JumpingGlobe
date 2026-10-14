/**
 * Wiring of the optional plate layers drawn over the globe: the static-polygon
 * outlines with plate names, the tectonic layers (boundaries, motion, subducting
 * plates, events) and the shared label board.
 */

import type { RotationTree } from "../plates/rotationTree";
import type { LabelView } from "../rendering/labelPlacement";
import type { Matrix4x4 } from "../rendering/matrixMath";
import { PlateOutlineOverlay } from "../rendering/plateOutlineOverlay";
import { TectonicOverlay } from "../rendering/tectonicOverlay";
import { createPlateDisplayControls, createPlateEventsPanel, createPlateLabelLayer, createTectonicLayerControls } from "../ui/panelFactories";
import type { AgeSource } from "../ui/timelineControl";
import { fetchPlateOutlines, fetchPlateTopologies } from "./globeApi";
import { LabelBoard } from "./labelBoard";
import { PlateOutlineController } from "./plateOutlineController";
import { TectonicsController } from "./tectonicsController";

/** Where the plate layers get the rotation model and their files (PlateLayerTracker). */
export interface PlateLayerSource {
  readonly rotationTree: RotationTree | null;
  readonly outlinesFile: string | null;
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
  labelBoard: LabelBoard;
};

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
  const labelBoard = new LabelBoard([tectonics, plateOutlines], createPlateLabelLayer());
  return { outlineOverlay, plateOutlines, tectonicOverlay, tectonics, labelBoard };
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
  return [plateLayers.plateOutlines.statusNote, plateLayers.tectonics.statusNote].filter(Boolean).join(" · ");
}
