/**
 * Paleomagnetic layers: loads the poles and TPW tables once, works out per age which data
 * exists (greying out the controls that have none), rebuilds the overlay when the age or the
 * layer choice changes, keeps the TPW grid's lift in step with the zoom and feeds the label board.
 */

import { gridLiftScale, groundLiftScale } from "../paleomag/gridLift";
import type { PaleoMagData } from "../paleomag/paleomagModel";
import { buildPaleoScene, type PaleoGroup, type PaleoLayerChoice } from "../paleomag/paleoScene";
import { polesAtAge, type PlacedPole } from "../paleomag/poleSelection";
import { TpwPaths, tpwRateNote, type TpwFrame, type TpwFrameOption } from "../paleomag/tpwPaths";
import type { RotationTree } from "../plates/rotationTree";
import { unitToLonLat } from "../plates/sphericalCoords";
import { RotationCache } from "../plates/topology/rotationCache";
import type { LabelRequest } from "../rendering/labelPlacement";
import type { SpaceLineData } from "../rendering/spaceLineOverlay";
import type { AgeSource } from "../ui/timelineControl";
import type { LabelProvider } from "./labelBoard";

/** Greys out controls, lists the TPW paths and shows coverage notes (PaleoLayerControls). */
export interface PaleoAvailabilitySink {
  setTpwFrameOptions(frameOptions: TpwFrameOption[]): void;
  setAvailability(tpwAvailable: boolean, magneticAvailable: boolean): void;
  setNotes(tpwNoteText: string, magneticNote: string): void;
}

/** Draws the line groups (SpaceLineOverlay). */
export interface PaleoLineSink {
  uploadGroups(lineGroups: ReadonlyMap<PaleoGroup, SpaceLineData>): void;
  setRadialScale(groupKey: PaleoGroup, radialScale: number): void;
  clearGroups(): void;
}

export type PaleoLayersDeps = {
  rotationSource: { readonly rotationTree: RotationTree | null };
  ageSource: AgeSource;
  layerChoice: PaleoLayerChoice;
  availabilitySink: PaleoAvailabilitySink;
  lineSink: PaleoLineSink;
  /** Fetches the paleomagnetic data (fetchPaleoMagData). */
  loadData: () => Promise<PaleoMagData>;
  /** Called when statusNote may have changed. */
  onStatusChange: () => void;
};

/** Data loaded once. */
type LoadedPaleo = { paleoData: PaleoMagData; tpwPaths: TpwPaths };

/** What exists at the displayed age. */
type AgeData = { ageInMyr: number; rotationTree: RotationTree; tpwFrameKey: string; tpwFrame: TpwFrame | null; placedPoles: PlacedPole[] };

const MAX_LISTED_POLES = 4;

export class PaleoLayersController implements LabelProvider {
  private loadedPaleo: LoadedPaleo | null = null;
  private loadState: "idle" | "loading" | "failed" = "idle";
  private currentAgeData: AgeData | null = null;
  private sceneKey = "";
  private hasScene = false;
  private gridLabels: LabelRequest[] = [];
  private fixedLabels: LabelRequest[] = [];
  private gridScale = 1;

  /**
   * Create the controller (the data is fetched on the first frame).
   *
   * Usage: once at start-up; call handleLayerChange() from the controls, updateFrame()
   * every frame, and register it with the label board.
   *
   * @param paleoDeps - Collaborators.
   */
  constructor(private readonly paleoDeps: PaleoLayersDeps) {}

  /**
   * Whether the overlay has anything to draw.
   *
   * Usage: frame loop.
   *
   * @returns True when the current scene has lines.
   */
  get isShowing(): boolean {
    return this.hasScene;
  }

  /**
   * Timeline status note.
   *
   * Usage: timeline status line.
   *
   * @returns A note when the data could not be loaded, otherwise "".
   */
  get statusNote(): string {
    return this.loadState === "failed" ? "Paleomagnetic data unavailable (see server log)" : "";
  }

  /**
   * React to a control change.
   *
   * Usage: PaleoLayerControls change callback.
   *
   * @returns Nothing.
   */
  handleLayerChange(): void {
    this.sceneKey = "";
  }

  /**
   * Fetch the data once.
   *
   * Usage: first frame.
   *
   * @returns Nothing; the data arrives asynchronously.
   */
  private ensureLoaded(): void {
    if (this.loadState !== "idle") return;
    this.loadState = "loading";
    this.paleoDeps
      .loadData()
      .then((paleoData) => {
        const tpwPaths = new TpwPaths(paleoData.tpwPaths);
        this.paleoDeps.availabilitySink.setTpwFrameOptions(tpwPaths.frameOptions);
        this.loadedPaleo = { paleoData, tpwPaths };
      })
      .catch((caughtError) => {
        console.warn("paleomagnetic data unavailable", caughtError);
        this.loadState = "failed";
        this.paleoDeps.onStatusChange();
      });
  }

  /**
   * Work out the data of the displayed age and update the controls.
   *
   * Usage: updateFrame, when the age, the TPW path or the rotation model changed.
   *
   * @param loadedPaleo - Loaded data.
   * @param rotationTree - Rotation model.
   * @param ageInMyr - Displayed age.
   * @param tpwFrameKey - Chosen TPW path.
   * @returns The data of the age.
   */
  private refreshAge(loadedPaleo: LoadedPaleo, rotationTree: RotationTree, ageInMyr: number, tpwFrameKey: string): AgeData {
    const rotationCache = new RotationCache(rotationTree);
    const tpwFrame = loadedPaleo.tpwPaths.frameAtAge(tpwFrameKey, ageInMyr);
    const placedPoles = polesAtAge(loadedPaleo.paleoData.paleoPoles, rotationCache, ageInMyr);
    this.paleoDeps.availabilitySink.setAvailability(tpwFrame !== null, placedPoles.length > 0);
    const coveredSpan = loadedPaleo.tpwPaths.coveredSpan(tpwFrameKey);
    const spanText = coveredSpan ? `path ${coveredSpan[0].toFixed(0)}–${coveredSpan[1].toFixed(0)} Ma` : "no TPW path";
    const [axisLongitude, axisLatitude] = tpwFrame ? unitToLonLat(tpwFrame.spinAxisUnit) : [0, 0];
    const frameText = tpwFrame
      ? `Spin axis ${axisLatitude.toFixed(1)}°N ${axisLongitude.toFixed(1)}°E (${spanText})`
      : `No TPW pole at ${ageInMyr} Ma (${spanText})`;
    const rateText = tpwRateNote(loadedPaleo.paleoData.tpwRates, loadedPaleo.paleoData.tpwNetAngles, ageInMyr);
    const poleNames = placedPoles.map((placedPole) => placedPole.paleoPole.poleName);
    const poleText = poleNames.length
      ? `Poles: ${poleNames.slice(0, MAX_LISTED_POLES).join(", ")}${poleNames.length > MAX_LISTED_POLES ? ` +${poleNames.length - MAX_LISTED_POLES}` : ""}`
      : `No paleomagnetic pole at ${ageInMyr} Ma`;
    this.paleoDeps.availabilitySink.setNotes([frameText, rateText].filter(Boolean).join(" · "), poleText);
    return { ageInMyr, rotationTree, tpwFrameKey, tpwFrame, placedPoles };
  }

  /**
   * Rebuild and upload the overlay.
   *
   * Usage: updateFrame, when the age data or the layer choice changed.
   *
   * @param currentAgeData - Data of the displayed age.
   * @returns Nothing.
   */
  private rebuildScene(currentAgeData: AgeData): void {
    const paleoScene = buildPaleoScene({ tpwFrame: currentAgeData.tpwFrame, placedPoles: currentAgeData.placedPoles, layerChoice: this.paleoDeps.layerChoice });
    this.paleoDeps.lineSink.uploadGroups(paleoScene.lineGroups);
    this.hasScene = paleoScene.lineGroups.size > 0;
    this.gridLabels = paleoScene.gridLabels;
    this.fixedLabels = paleoScene.fixedLabels;
  }

  /**
   * Per-frame update.
   *
   * Usage: frame loop, before drawing.
   *
   * @param cameraHeightM - Camera height (the grid's lift follows it).
   * @returns Nothing.
   */
  updateFrame(cameraHeightM: number): void {
    this.ensureLoaded();
    const loadedPaleo = this.loadedPaleo;
    const rotationTree = this.paleoDeps.rotationSource.rotationTree;
    if (!loadedPaleo || !rotationTree) return;
    const ageInMyr = this.paleoDeps.ageSource.currentAgeMa;
    const tpwFrameKey = this.paleoDeps.layerChoice.tpwFrameKey;
    const previousData = this.currentAgeData;
    if (!previousData || previousData.ageInMyr !== ageInMyr || previousData.rotationTree !== rotationTree || previousData.tpwFrameKey !== tpwFrameKey) {
      this.currentAgeData = this.refreshAge(loadedPaleo, rotationTree, ageInMyr, tpwFrameKey);
      this.sceneKey = "";
    }
    const layerChoice = this.paleoDeps.layerChoice;
    const nextSceneKey = [layerChoice.showSpinAxis, layerChoice.showPaleoGrid, layerChoice.showMagneticPoles, layerChoice.showFieldLines, layerChoice.fieldShellCount].join();
    if (nextSceneKey !== this.sceneKey) {
      this.rebuildScene(this.currentAgeData!);
      this.sceneKey = nextSceneKey;
    }
    this.gridScale = gridLiftScale(cameraHeightM);
    this.paleoDeps.lineSink.setRadialScale("paleoGrid", this.gridScale);
    this.paleoDeps.lineSink.setRadialScale("groundMarks", groundLiftScale(cameraHeightM));
  }

  /**
   * Paleomagnetic labels to show this frame.
   *
   * Usage: label board (LabelProvider).
   *
   * @returns Pole and axis labels, then grid labels at the grid's current lift.
   */
  labelRequests(): LabelRequest[] {
    if (!this.hasScene) return [];
    return [...this.fixedLabels, ...this.gridLabels.map((gridLabel) => ({ ...gridLabel, labelLift: this.gridScale }))];
  }
}
