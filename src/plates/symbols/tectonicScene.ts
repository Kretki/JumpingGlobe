/**
 * Build everything the tectonic layers draw at one age from the resolved topologies:
 * boundary symbols, plate-motion ticks, the shading of plates being subducted, the
 * outlines of plates that appear or disappear around this age, and their labels.
 * Output is geometry per drawing style plus label requests; colours live in the renderer.
 */

import type { LabelRequest } from "../../rendering/labelPlacement";
import type { UnitVector } from "../sphericalCoords";
import { subductingPlates } from "../topology/boundaryKinematics";
import type { PlateEvent, PlateLifetime } from "../topology/plateLifetimes";
import { plateDisplayName } from "../topology/plateLifetimes";
import type { ResolvedPlate, ResolvedTopologies } from "../topology/topologyResolver";
import { normalizeOrNull } from "../unitVectorMath";
import { addBoundarySymbols, emptyBoundaryGeometry, type PlateMover } from "./boundarySymbols";
import { addMotionTicks } from "./motionTicks";
import { addRingFill } from "./plateFill";
import { SymbolGeometry } from "./symbolGeometry";

/** Which tectonic layers the user wants. */
export interface TectonicLayerChoice {
  readonly showBoundaries: boolean;
  readonly showMotion: boolean;
  readonly showSubducting: boolean;
  readonly showEvents: boolean;
}

/** Drawing styles of the tectonic layers (one colour and primitive set each). */
export type TectonicStyle =
  | "divergent"
  | "subduction"
  | "transform"
  | "other"
  | "motion"
  | "subductingFill"
  | "subductingOutline"
  | "appearOutline"
  | "vanishOutline";

export type TectonicSceneInput = {
  resolvedTopologies: ResolvedTopologies;
  lifetimeMap: Map<number, PlateLifetime>;
  eventsByPlate: Map<number, PlateEvent[]>;
  layerChoice: TectonicLayerChoice;
  /** Symbol size unit (radians), from the camera height. */
  symbolScale: number;
  plateMover: PlateMover;
};

export type TectonicScene = { styledGeometry: Map<TectonicStyle, SymbolGeometry>; labelRequests: LabelRequest[] };

/** Minimum share of a plate's edge going down at trenches for it to be shaded as subducting. */
const SUBDUCTING_SHARE = 0.15;

/** A plate is highlighted during the first / last EVENT_WINDOW_MYR of its life. */
export const EVENT_WINDOW_MYR = 15;

/**
 * Label position of a plate: the normalised mean of its ring.
 *
 * Usage: plate annotations.
 *
 * @param resolvedPlate - Plate polygon.
 * @returns Unit vector, or null for a degenerate ring.
 */
function plateAnchor(resolvedPlate: ResolvedPlate): UnitVector | null {
  const vertexSum = resolvedPlate.ringUnits.reduce((sumVector, ringUnit) => [sumVector[0] + ringUnit[0], sumVector[1] + ringUnit[1], sumVector[2] + ringUnit[2]], [0, 0, 0]);
  return normalizeOrNull(vertexSum);
}

/**
 * Geometry of a style, created on first use.
 *
 * Usage: every layer.
 *
 * @param tectonicScene - Scene being built.
 * @param tectonicStyle - Style.
 * @returns The style's geometry.
 */
function geometryFor(tectonicScene: TectonicScene, tectonicStyle: TectonicStyle): SymbolGeometry {
  let symbolGeometry = tectonicScene.styledGeometry.get(tectonicStyle);
  if (!symbolGeometry) {
    symbolGeometry = new SymbolGeometry();
    tectonicScene.styledGeometry.set(tectonicStyle, symbolGeometry);
  }
  return symbolGeometry;
}

/**
 * Plate boundaries with their symbols.
 *
 * Usage: "Plate boundaries" layer.
 *
 * @param sceneInput - Inputs.
 * @param tectonicScene - Scene being built.
 * @returns Nothing.
 */
function addBoundaryLayer(sceneInput: TectonicSceneInput, tectonicScene: TectonicScene): void {
  const boundaryGeometry = emptyBoundaryGeometry();
  for (const boundarySegment of sceneInput.resolvedTopologies.boundarySegments) {
    addBoundarySymbols(boundarySegment, sceneInput.plateMover, sceneInput.symbolScale, boundaryGeometry);
  }
  for (const [boundaryKind, symbolGeometry] of Object.entries(boundaryGeometry)) {
    tectonicScene.styledGeometry.set(boundaryKind as TectonicStyle, symbolGeometry);
  }
}

/**
 * Motion ticks along every plate's edge.
 *
 * Usage: "Plate motion" layer.
 *
 * @param sceneInput - Inputs.
 * @param tectonicScene - Scene being built.
 * @returns Nothing.
 */
function addMotionLayer(sceneInput: TectonicSceneInput, tectonicScene: TectonicScene): void {
  const symbolGeometry = geometryFor(tectonicScene, "motion");
  for (const resolvedPlate of sceneInput.resolvedTopologies.resolvedPlates) {
    addMotionTicks(resolvedPlate, sceneInput.plateMover, sceneInput.symbolScale, symbolGeometry);
  }
}

/**
 * Label of a plate being subducted.
 *
 * Usage: addSubductingLayer.
 *
 * @param resolvedPlate - Plate.
 * @param plateLifetime - Its lifetime, if known.
 * @param ageInMyr - Displayed age.
 * @returns e.g. "Farallon ↓ gone by 40 Ma", or "Pacific ↓" for plates that still exist.
 */
function subductingLabel(resolvedPlate: ResolvedPlate, plateLifetime: PlateLifetime | undefined, ageInMyr: number): string {
  const plateName = plateDisplayName(resolvedPlate.topologyName, resolvedPlate.plateNumber);
  const vanishAge = plateLifetime?.vanishAgeMa ?? 0;
  return vanishAge > 0 && vanishAge < ageInMyr ? `${plateName} ↓ gone by ${vanishAge.toFixed(0)} Ma` : `${plateName} ↓`;
}

/**
 * Shading, outline and label of every plate on the downgoing side of a subduction zone.
 *
 * Usage: "Subducting plates" layer.
 *
 * @param sceneInput - Inputs.
 * @param tectonicScene - Scene being built.
 * @returns Nothing.
 */
function addSubductingLayer(sceneInput: TectonicSceneInput, tectonicScene: TectonicScene): void {
  const { resolvedTopologies, lifetimeMap } = sceneInput;
  const downgoingPlates = subductingPlates(resolvedTopologies.boundarySegments, resolvedTopologies.resolvedPlates, SUBDUCTING_SHARE);
  for (const resolvedPlate of resolvedTopologies.resolvedPlates) {
    if (!downgoingPlates.has(resolvedPlate.plateNumber)) continue;
    addRingFill(resolvedPlate.ringUnits, geometryFor(tectonicScene, "subductingFill"));
    geometryFor(tectonicScene, "subductingOutline").addPolyline(resolvedPlate.ringUnits, true);
    const labelUnit = plateAnchor(resolvedPlate);
    if (!labelUnit) continue;
    const labelText = subductingLabel(resolvedPlate, lifetimeMap.get(resolvedPlate.plateNumber), resolvedTopologies.ageInMyr);
    tectonicScene.labelRequests.push({ labelText, labelUnit, labelStyle: "subducting" });
  }
}

/**
 * The event of a plate whose highlight window contains an age.
 *
 * Usage: addEventLayer.
 *
 * @param plateEvents - Events of one plate.
 * @param ageInMyr - Displayed age.
 * @returns An appearance in its first EVENT_WINDOW_MYR, a disappearance in its last, or undefined.
 */
function activeEvent(plateEvents: PlateEvent[], ageInMyr: number): PlateEvent | undefined {
  return plateEvents.find((plateEvent) =>
    plateEvent.eventKind === "appear"
      ? ageInMyr <= plateEvent.eventAgeMa && ageInMyr >= plateEvent.eventAgeMa - EVENT_WINDOW_MYR
      : ageInMyr >= plateEvent.eventAgeMa && ageInMyr <= plateEvent.eventAgeMa + EVENT_WINDOW_MYR
  );
}

/**
 * Outline and label of plates that have just appeared or are about to disappear.
 *
 * Usage: "Plate events" layer.
 *
 * @param sceneInput - Inputs.
 * @param tectonicScene - Scene being built.
 * @returns Nothing.
 */
function addEventLayer(sceneInput: TectonicSceneInput, tectonicScene: TectonicScene): void {
  const ageInMyr = sceneInput.resolvedTopologies.ageInMyr;
  for (const resolvedPlate of sceneInput.resolvedTopologies.resolvedPlates) {
    const plateEvent = activeEvent(sceneInput.eventsByPlate.get(resolvedPlate.plateNumber) ?? [], ageInMyr);
    if (!plateEvent) continue;
    const isAppearing = plateEvent.eventKind === "appear";
    geometryFor(tectonicScene, isAppearing ? "appearOutline" : "vanishOutline").addPolyline(resolvedPlate.ringUnits, true);
    const labelUnit = plateAnchor(resolvedPlate);
    if (!labelUnit) continue;
    const eventText = isAppearing ? `▲ ${plateEvent.plateName} appeared ${plateEvent.eventAgeMa.toFixed(0)} Ma` : `▼ ${plateEvent.plateName} vanishes ${plateEvent.eventAgeMa.toFixed(0)} Ma`;
    tectonicScene.labelRequests.push({ labelText: eventText, labelUnit, labelStyle: isAppearing ? "appear" : "vanish" });
  }
}

/**
 * Build the tectonic scene for the layers the user has switched on.
 *
 * Usage: whenever the age, the layer choice or the symbol scale changes.
 *
 * @param sceneInput - Resolved topologies, lifetimes, events, choices and scale.
 * @returns Geometry per style and label requests (event labels first: they matter most).
 */
export function buildTectonicScene(sceneInput: TectonicSceneInput): TectonicScene {
  const tectonicScene: TectonicScene = { styledGeometry: new Map(), labelRequests: [] };
  const layerChoice = sceneInput.layerChoice;
  if (layerChoice.showEvents) addEventLayer(sceneInput, tectonicScene);
  if (layerChoice.showSubducting) addSubductingLayer(sceneInput, tectonicScene);
  if (layerChoice.showBoundaries) addBoundaryLayer(sceneInput, tectonicScene);
  if (layerChoice.showMotion) addMotionLayer(sceneInput, tectonicScene);
  return tectonicScene;
}
