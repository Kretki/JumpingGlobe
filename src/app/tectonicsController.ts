/**
 * Tectonic layers on demand: loads the plate-topology model the first time a layer is
 * ticked, resolves plates and boundaries whenever the age changes, rebuilds the
 * symbols when the age, zoom or layer choice changes, and feeds the overlay, the
 * events list and the label board.
 */

import type { LabelRequest } from "../rendering/labelPlacement";
import type { RotationTree } from "../plates/rotationTree";
import type { SymbolGeometry } from "../plates/symbols/symbolGeometry";
import { buildTectonicScene, type TectonicLayerChoice, type TectonicStyle } from "../plates/symbols/tectonicScene";
import { movedPoint } from "../plates/topology/boundaryKinematics";
import { eventsByPlateNumber, eventsNear, plateEvents, plateLifetimes, type PlateEvent, type PlateLifetime } from "../plates/topology/plateLifetimes";
import { RotationCache } from "../plates/topology/rotationCache";
import type { TopologyModel } from "../plates/topology/topologyModel";
import { TopologyResolver, type ResolvedTopologies } from "../plates/topology/topologyResolver";
import { WGS84_SEMI_MAJOR } from "../geodesy/wgs84Ellipsoid";
import type { AgeSource } from "../ui/timelineControl";
import type { LabelProvider } from "./labelBoard";

/** Rotation model and topology availability (PlateLayerTracker). */
export interface TopologySource {
  readonly rotationTree: RotationTree | null;
  readonly topologyFile: string | null;
  /** Server-side export state ("ready", "building", "failed", "unavailable", ...). */
  readonly topologyStatus: string;
  readonly topologyDetail: string;
}

/** Draws the tectonic scene (TectonicOverlay). */
export interface TectonicSceneSink {
  uploadScene(styledGeometry: Map<TectonicStyle, SymbolGeometry>): void;
  clearScene(): void;
}

/** Lists plate events (PlateEventsPanel). */
export interface PlateEventsSink {
  showEvents(plateEvents: PlateEvent[], ageInMyr: number): void;
  hideEvents(): void;
}

export type TectonicsDeps = {
  topologySource: TopologySource;
  ageSource: AgeSource;
  layerChoice: TectonicLayerChoice;
  sceneSink: TectonicSceneSink;
  eventsSink: PlateEventsSink;
  /** Fetches and prepares the topology model (fetchPlateTopologies). */
  loadTopologies: () => Promise<TopologyModel>;
  /** Called when statusNote may have changed. */
  onStatusChange: () => void;
};

/** What is derived once from the loaded model. */
type LoadedTectonics = {
  topologyResolver: TopologyResolver;
  lifetimeMap: Map<number, PlateLifetime>;
  eventList: PlateEvent[];
  eventsByPlate: Map<number, PlateEvent[]>;
};

/** Symbol size (radians) per metre of camera height, and its limits. */
const SYMBOL_SCALE_PER_HEIGHT = 0.012 / WGS84_SEMI_MAJOR;
const MIN_SYMBOL_SCALE = 0.0004;
const MAX_SYMBOL_SCALE = 0.03;
/** Symbols are rebuilt when the zoom changes the scale by more than this factor. */
const SCALE_STEP = 1.25;
const EVENT_LIST_WINDOW_MYR = 40;
const EVENT_LIST_LENGTH = 8;

/**
 * Quantised symbol-scale step for a camera height.
 *
 * Usage: rebuild symbols only on noticeable zoom changes.
 *
 * @param cameraHeightM - Camera height above the surface.
 * @returns Integer step; the scale is SCALE_STEP ** step.
 */
function scaleStep(cameraHeightM: number): number {
  const rawScale = Math.min(MAX_SYMBOL_SCALE, Math.max(MIN_SYMBOL_SCALE, cameraHeightM * SYMBOL_SCALE_PER_HEIGHT));
  return Math.round(Math.log(rawScale) / Math.log(SCALE_STEP));
}

export class TectonicsController implements LabelProvider {
  private loadedTectonics: LoadedTectonics | null = null;
  private isLoading = false;
  private loadFailed = false;
  private resolvedTopologies: ResolvedTopologies | null = null;
  private resolvedTree: RotationTree | null = null;
  private sceneKey = "";
  private sceneLabels: LabelRequest[] = [];
  private listedAgeMa = NaN;

  /**
   * Create the controller (nothing is loaded until a layer is ticked).
   *
   * Usage: once at start-up; call handleLayerChange() from the checkboxes, updateFrame()
   * every frame, and register it with the label board.
   *
   * @param tectonicsDeps - Collaborators.
   */
  constructor(private readonly tectonicsDeps: TectonicsDeps) {}

  /**
   * Whether any tectonic layer is ticked.
   *
   * Usage: internal and frame loop.
   *
   * @returns True when at least one of the four layers is on.
   */
  private get anyLayer(): boolean {
    const layerChoice = this.tectonicsDeps.layerChoice;
    return layerChoice.showBoundaries || layerChoice.showMotion || layerChoice.showSubducting || layerChoice.showEvents;
  }

  /**
   * Whether the overlay should be drawn this frame.
   *
   * Usage: frame loop.
   *
   * @returns True when a layer is on and the model is loaded.
   */
  get isShowing(): boolean {
    return this.anyLayer && this.loadedTectonics !== null;
  }

  /**
   * Timeline status note about the tectonic layers.
   *
   * Usage: timeline status line.
   *
   * @returns "" when nothing to report, otherwise why the layers are not shown yet.
   */
  get statusNote(): string {
    if (!this.anyLayer || this.loadedTectonics) return "";
    if (this.loadFailed) return "Plate boundaries unavailable (untick all plate layers and tick again to retry)";
    const topologySource = this.tectonicsDeps.topologySource;
    if (topologySource.topologyStatus === "failed" || topologySource.topologyStatus === "unavailable") {
      return `Plate boundaries unavailable: ${topologySource.topologyDetail || topologySource.topologyStatus}`;
    }
    return "Preparing plate boundaries…";
  }

  /**
   * React to a checkbox change.
   *
   * Usage: TectonicLayerControls change callback.
   *
   * @returns Nothing.
   */
  handleLayerChange(): void {
    this.sceneKey = "";
    this.listedAgeMa = NaN;
    if (!this.anyLayer) {
      this.loadFailed = false;
      this.sceneLabels = [];
      this.tectonicsDeps.sceneSink.clearScene();
    }
    if (!this.tectonicsDeps.layerChoice.showEvents) this.tectonicsDeps.eventsSink.hideEvents();
    this.tectonicsDeps.onStatusChange();
  }

  /**
   * Start loading the model once it is wanted, exported by the server, and the rotation model is known.
   *
   * Usage: every frame while a layer is on (cheap when nothing to do).
   *
   * @param rotationTree - Rotation model (its oldest age bounds the events).
   * @returns Nothing; the model arrives asynchronously.
   */
  private ensureLoaded(rotationTree: RotationTree): void {
    if (this.loadedTectonics || this.isLoading || this.loadFailed || !this.tectonicsDeps.topologySource.topologyFile) return;
    this.isLoading = true;
    this.tectonicsDeps
      .loadTopologies()
      .then((topologyModel) => {
        const lifetimeMap = plateLifetimes(topologyModel.plateTopologies);
        const eventList = plateEvents(lifetimeMap, rotationTree.maxAgeMa);
        this.loadedTectonics = { topologyResolver: new TopologyResolver(topologyModel), lifetimeMap, eventList, eventsByPlate: eventsByPlateNumber(eventList) };
      })
      .catch((caughtError) => {
        console.warn("plate topologies unavailable", caughtError);
        this.loadFailed = true;
      })
      .finally(() => {
        this.isLoading = false;
        this.tectonicsDeps.onStatusChange();
      });
  }

  /**
   * Resolve plates and boundaries when the age or rotation model changed.
   *
   * Usage: updateFrame.
   *
   * @param loadedTectonics - Loaded model.
   * @param rotationTree - Rotation model.
   * @param ageInMyr - Displayed age.
   * @returns The resolution for this age.
   */
  private resolvedAt(loadedTectonics: LoadedTectonics, rotationTree: RotationTree, ageInMyr: number): ResolvedTopologies {
    if (!this.resolvedTopologies || this.resolvedTopologies.ageInMyr !== ageInMyr || this.resolvedTree !== rotationTree) {
      this.resolvedTopologies = loadedTectonics.topologyResolver.resolveAt(rotationTree, ageInMyr);
      this.resolvedTree = rotationTree;
    }
    return this.resolvedTopologies;
  }

  /**
   * Rebuild and upload the scene.
   *
   * Usage: updateFrame, when the age, zoom step or layer choice changed.
   *
   * @param loadedTectonics - Loaded model.
   * @param resolvedTopologies - Resolution for the displayed age.
   * @param rotationTree - Rotation model.
   * @param symbolScale - Symbol scale (radians).
   * @returns Nothing.
   */
  private rebuildScene(loadedTectonics: LoadedTectonics, resolvedTopologies: ResolvedTopologies, rotationTree: RotationTree, symbolScale: number): void {
    const rotationCache = new RotationCache(rotationTree);
    const ageInMyr = resolvedTopologies.ageInMyr;
    const tectonicScene = buildTectonicScene({
      resolvedTopologies,
      lifetimeMap: loadedTectonics.lifetimeMap,
      eventsByPlate: loadedTectonics.eventsByPlate,
      layerChoice: this.tectonicsDeps.layerChoice,
      symbolScale,
      plateMover: (plateNumber, pointUnit, timeSpanMyr) => movedPoint(rotationCache, plateNumber, ageInMyr, pointUnit, timeSpanMyr),
    });
    this.tectonicsDeps.sceneSink.uploadScene(tectonicScene.styledGeometry);
    this.sceneLabels = tectonicScene.labelRequests;
  }

  /**
   * Refresh the events list when the age changed.
   *
   * Usage: updateFrame while "Plate events" is ticked.
   *
   * @param loadedTectonics - Loaded model.
   * @param ageInMyr - Displayed age.
   * @returns Nothing.
   */
  private refreshEventList(loadedTectonics: LoadedTectonics, ageInMyr: number): void {
    if (ageInMyr === this.listedAgeMa) return;
    this.listedAgeMa = ageInMyr;
    this.tectonicsDeps.eventsSink.showEvents(eventsNear(loadedTectonics.eventList, ageInMyr, EVENT_LIST_WINDOW_MYR, EVENT_LIST_LENGTH), ageInMyr);
  }

  /**
   * Per-frame update.
   *
   * Usage: frame loop, before drawing.
   *
   * @param cameraHeightM - Camera height (symbol size follows the zoom).
   * @returns Nothing.
   */
  updateFrame(cameraHeightM: number): void {
    const rotationTree = this.tectonicsDeps.topologySource.rotationTree;
    if (!this.anyLayer || !rotationTree) return;
    this.ensureLoaded(rotationTree);
    const loadedTectonics = this.loadedTectonics;
    if (!loadedTectonics) return;
    const ageInMyr = this.tectonicsDeps.ageSource.currentAgeMa;
    const resolvedTopologies = this.resolvedAt(loadedTectonics, rotationTree, ageInMyr);
    const symbolStep = scaleStep(cameraHeightM);
    const layerChoice = this.tectonicsDeps.layerChoice;
    const choiceKey = [layerChoice.showBoundaries, layerChoice.showMotion, layerChoice.showSubducting, layerChoice.showEvents].join();
    const nextSceneKey = `${ageInMyr}|${symbolStep}|${choiceKey}`;
    if (nextSceneKey !== this.sceneKey) {
      this.rebuildScene(loadedTectonics, resolvedTopologies, rotationTree, SCALE_STEP ** symbolStep);
      this.sceneKey = nextSceneKey;
    }
    if (layerChoice.showEvents) this.refreshEventList(loadedTectonics, ageInMyr);
  }

  /**
   * Tectonic annotations to show this frame.
   *
   * Usage: label board (LabelProvider).
   *
   * @returns Labels of plate events and subducting plates, or [] when the layers are off.
   */
  labelRequests(): LabelRequest[] {
    return this.isShowing ? this.sceneLabels : [];
  }
}
