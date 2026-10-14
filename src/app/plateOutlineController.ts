/**
 * Plate outlines on demand: loads the outline layer the first time the user ticks
 * "Plate outlines", moves it with the plates whenever the age changes, and places
 * the plate names each frame while "Plate names" is ticked.
 */

import { outlineBufferLength, reconstructOutlines, type PlateLabel } from "../plates/outlineReconstruction";
import type { PlateOutline } from "../plates/plateOutlines";
import type { RotationTree } from "../plates/rotationTree";
import { placeLabels, type LabelView, type PlacedLabel } from "../rendering/labelPlacement";
import type { PlateDisplayChoice } from "../ui/plateDisplayControls";
import type { AgeSource } from "../ui/timelineControl";

/** Where the rotation model and the outline file name come from (PlateLayerTracker). */
export interface OutlineSource {
  readonly rotationTree: RotationTree | null;
  readonly outlinesFile: string | null;
}

/** Receives the reconstructed wireframe (PlateOutlineOverlay). */
export interface OutlineLineSink {
  uploadLines(linePositions: Float32Array, vertexCount: number): void;
}

/** Shows plate names (PlateLabelLayer). */
export interface PlateLabelSink {
  renderLabels(placedLabels: PlacedLabel[]): void;
  hideLabels(): void;
}

export type PlateOutlineDeps = {
  outlineSource: OutlineSource;
  ageSource: AgeSource;
  displayChoice: PlateDisplayChoice;
  lineSink: OutlineLineSink;
  labelSink: PlateLabelSink;
  /** Fetches and prepares an outline file (fetchPlateOutlines). */
  loadOutlines: (outlinesFile: string) => Promise<PlateOutline[]>;
  /** Called when statusNote may have changed. */
  onStatusChange: () => void;
};

export class PlateOutlineController {
  private outlineList: PlateOutline[] | null = null;
  private linePositions = new Float32Array(0);
  private plateLabels: PlateLabel[] = [];
  private isLoading = false;
  private loadFailed = false;
  private shownAgeMa = NaN;
  private shownTree: RotationTree | null = null;

  /**
   * Create the controller (nothing is loaded until outlines are requested).
   *
   * Usage: once at start-up; call handleDisplayChange() from the checkboxes and
   * updateFrame() every frame.
   *
   * @param outlineDeps - Collaborators.
   */
  constructor(private readonly outlineDeps: PlateOutlineDeps) {}

  /**
   * Whether the wireframe should be drawn this frame.
   *
   * Usage: frame loop, before calling the overlay's draw.
   *
   * @returns True when outlines are ticked and loaded.
   */
  get isShowing(): boolean {
    return this.outlineDeps.displayChoice.showOutlines && this.outlineList !== null;
  }

  /**
   * Timeline status note about the outlines.
   *
   * Usage: timeline status line.
   *
   * @returns "" when nothing to report, otherwise why outlines are not shown yet.
   */
  get statusNote(): string {
    if (!this.outlineDeps.displayChoice.showOutlines || this.outlineList) return "";
    if (this.loadFailed) return "Plate outlines unavailable (untick and tick again to retry)";
    return "Preparing plate outlines…";
  }

  /**
   * React to a checkbox change.
   *
   * Usage: PlateDisplayControls change callback.
   *
   * @returns Nothing.
   */
  handleDisplayChange(): void {
    const displayChoice = this.outlineDeps.displayChoice;
    if (!displayChoice.showOutlines) this.loadFailed = false;
    if (!displayChoice.showNames) this.outlineDeps.labelSink.hideLabels();
    this.outlineDeps.onStatusChange();
  }

  /**
   * Start loading the outline layer once it is wanted and the server has built it.
   *
   * Usage: every frame (cheap when nothing to do).
   *
   * @returns Nothing; the layer arrives asynchronously.
   */
  private ensureLoaded(): void {
    const outlinesFile = this.outlineDeps.outlineSource.outlinesFile;
    if (this.outlineList || this.isLoading || this.loadFailed || !outlinesFile) return;
    this.isLoading = true;
    this.outlineDeps
      .loadOutlines(outlinesFile)
      .then((outlineList) => {
        this.outlineList = outlineList;
        this.linePositions = new Float32Array(outlineBufferLength(outlineList));
        this.shownAgeMa = NaN;
      })
      .catch((caughtError) => {
        console.warn("plate outlines unavailable", caughtError);
        this.loadFailed = true;
      })
      .finally(() => {
        this.isLoading = false;
        this.outlineDeps.onStatusChange();
      });
  }

  /**
   * Move the outlines to the current age when it (or the rotation model) changed.
   *
   * Usage: every frame while outlines are shown.
   *
   * @param outlineList - Loaded outlines.
   * @param rotationTree - Rotation model.
   * @returns Nothing; uploads new lines and refreshes the label anchors.
   */
  private reconstructIfStale(outlineList: PlateOutline[], rotationTree: RotationTree): void {
    const ageInMyr = this.outlineDeps.ageSource.currentAgeMa;
    if (ageInMyr === this.shownAgeMa && rotationTree === this.shownTree) return;
    const outlineFrame = reconstructOutlines(outlineList, rotationTree, ageInMyr, this.linePositions);
    this.outlineDeps.lineSink.uploadLines(this.linePositions, outlineFrame.vertexCount);
    this.plateLabels = outlineFrame.plateLabels;
    this.shownAgeMa = ageInMyr;
    this.shownTree = rotationTree;
  }

  /**
   * Per-frame update: load on demand, follow the age, place the names.
   *
   * Usage: frame loop, before drawing.
   *
   * @param labelView - Camera and viewport of this frame.
   * @returns Nothing.
   */
  updateFrame(labelView: LabelView): void {
    const displayChoice = this.outlineDeps.displayChoice;
    if (!displayChoice.showOutlines) return;
    this.ensureLoaded();
    const rotationTree = this.outlineDeps.outlineSource.rotationTree;
    if (!this.outlineList || !rotationTree) return;
    this.reconstructIfStale(this.outlineList, rotationTree);
    if (displayChoice.showNames) this.outlineDeps.labelSink.renderLabels(placeLabels(this.plateLabels, labelView));
  }
}
