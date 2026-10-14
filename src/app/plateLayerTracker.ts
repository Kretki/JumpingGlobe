/** Rotation model and server-side plate-layer readiness. */

import { WORLD_FILE } from "../land/lod.config";
import { RotationTree } from "../plates/rotationTree";
import { fetchPlateStatus, fetchRotationModel } from "./globeApi";

const POLL_INTERVAL_MS = 3000;

/** Reactions to tracker events. */
export type PlateTrackerListener = {
  /** The rotation model loaded. */
  onRotationModel: (maxAgeMa: number) => void;
  /** The plate-tagged world twin became available (fired once). */
  onWorldTwin: (twinFile: string) => void;
  /** Anything shown in the timeline status changed. */
  onStatusChange: () => void;
};

export class PlateLayerTracker {
  rotationTree: RotationTree | null = null;
  rotationModelError = false;
  buildStatus = "loading";
  statusDetail = "";
  /** LOD file → plate-tagged twin, for twins the server has finished. */
  plateFiles: Record<string, string> = {};
  staticFile: string | null = null;
  /** Plate-outline file once the server has built it. */
  outlinesFile: string | null = null;

  /**
   * Create the tracker.
   *
   * Usage: ``new PlateLayerTracker(listener, () => disposed)``; call loadRotationModel().
   *
   * @param trackerListener - Event callbacks.
   * @param isStopped - Polling stops once this returns true.
   */
  constructor(
    private readonly trackerListener: PlateTrackerListener,
    private readonly isStopped: () => boolean
  ) {}

  /**
   * Load the rotation model, then follow the plate-layer build.
   *
   * Usage: once at start-up.
   *
   * @returns Resolves when the model request settled (polling continues in the background).
   */
  async loadRotationModel(): Promise<void> {
    try {
      const rotationModel = await fetchRotationModel();
      this.rotationTree = new RotationTree(rotationModel);
      this.trackerListener.onRotationModel(Math.round(rotationModel.maxAge));
      void this.pollPlateLayers();
    } catch (caughtError) {
      console.warn("rotation model unavailable", caughtError);
      this.rotationModelError = true;
    }
    this.trackerListener.onStatusChange();
  }

  /**
   * Follow the server's background build: world twin first (seconds), detail twins later.
   *
   * Usage: started by loadRotationModel.
   *
   * @returns Resolves when the build finished, failed or the tracker stopped.
   */
  private async pollPlateLayers(): Promise<void> {
    let worldRequested = false;
    while (!this.isStopped()) {
      try {
        const statusResponse = await fetchPlateStatus();
        this.buildStatus = statusResponse.status;
        this.statusDetail = statusResponse.detail;
        this.plateFiles = statusResponse.plateFiles;
        this.staticFile = statusResponse.staticFile;
        this.outlinesFile = statusResponse.outlinesFile;
      } catch (caughtError) {
        this.buildStatus = "failed";
        this.statusDetail = String(caughtError);
        this.trackerListener.onStatusChange();
        return;
      }
      const worldTwin = this.plateFiles[WORLD_FILE];
      if (worldTwin && !worldRequested) {
        worldRequested = true;
        this.trackerListener.onWorldTwin(worldTwin);
      }
      this.trackerListener.onStatusChange();
      if (this.buildStatus !== "building") return;
      await new Promise((resolveWait) => window.setTimeout(resolveWait, POLL_INTERVAL_MS));
    }
  }
}
