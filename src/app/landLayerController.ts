/**
 * Which land is on the GPU: the world base layer (plain or plate-tagged) and the
 * view detail layer (present-day bbox tiles, or a past-age cap while paused).
 */

import { FIELD_OF_VIEW_Y } from "../camera/orbitCamera";
import { boundsContain, type BoundingBox } from "../land/boundingBox";
import type { LandLoader, LandLoadProgress, LandLoadResult, LandProgressFn } from "../land/landLoader";
import { featureLimitFromHeight, lodFileFromHeight, minAreaFromHeight, WORLD_FILE } from "../land/lod.config";
import type { LandMesh } from "../land/meshTypes";
import { viewBounds, viewHalfAngle, visibleGroundRadiusDeg } from "../land/viewGeometry";
import { preparePlateMesh, reconstruct, type PlateMesh, type ReconstructStats } from "../plates/reconstruct";
import { angularDistanceDeg, lonLatToUnit } from "../plates/sphericalCoords";
import type { LandClip } from "../rendering/globeRenderer";
import type { GpuMeshSlot } from "../rendering/meshSlot";
import type { AgeSource } from "../ui/timelineControl";
import type { LandProgressPanel } from "../ui/landProgressPanel";
import type { PlateLayerTracker } from "./plateLayerTracker";

const VIEW_LOAD_DELAY_MS = 180;
const PAST_LOAD_DELAY_MS = 250;
/** Reload before any visible ground (+5 %) leaves the loaded detail. */
const VISIBLE_MARGIN = 1.05;
/** Past caps are loaded larger than the view so small pans need no refetch. */
const PAST_RADIUS_SCALE = 1.3;
const PAST_RADIUS_PAD_DEG = 0.02;

export type LandLayerDeps = {
  createLoader: (onProgress?: LandProgressFn) => LandLoader;
  baseSlot: GpuMeshSlot;
  detailSlot: GpuMeshSlot;
  progressPanel: LandProgressPanel;
  plateTracker: PlateLayerTracker;
  ageSource: AgeSource;
  /** Current camera height (read again when delayed loads fire). */
  cameraHeight: () => number;
  /** Current canvas width / height. */
  viewportAspect: () => number;
  /** Something shown in the timeline status changed. */
  onStatusChange: () => void;
};

/** The past-age cap the detail layer currently covers. */
type LoadedPast = { twinFile: string; ageInMyr: number; centerLon: number; centerLat: number; radiusDeg: number };

/** Last view a load was queued or started for. */
type ViewSnapshot = { longitudeDeg: number; latitudeDeg: number; heightMeters: number };

const EMPTY_VIEW: ViewSnapshot = { longitudeDeg: NaN, latitudeDeg: NaN, heightMeters: NaN };

/**
 * One-line description of a load result for the status read-out.
 *
 * Usage: coordinates panel "land" line.
 *
 * @param labelPrefix - Prefix such as "world " or "150 Ma ".
 * @param loadResult - Loaded result.
 * @returns e.g. "world land_lod0.gpkg · 228 feats · 180600 tris · maxEdgeLength 152999m".
 */
export function describeResult(labelPrefix: string, loadResult: LandLoadResult): string {
  const meshStats = loadResult.meshStats;
  const failureCount = meshStats ? meshStats.earcutEmpty + meshStats.earcutThrow : 0;
  return (
    `${labelPrefix}${loadResult.fileName} · ${loadResult.featureCount} feats · ${loadResult.landMesh.triangleCount} tris` +
    (failureCount ? ` · fail ${failureCount}` : "") +
    (meshStats ? ` · maxEdgeLength ${Math.round(meshStats.maxEdgeMObserved)}m` : "")
  );
}

export class LandLayerController {
  landStatus = "loading…";
  /** Part of the base layer hidden while detail is shown. */
  detailClip: LandClip | null = null;
  private readonly detailLoader: LandLoader;
  private readonly plateWorldLoader: LandLoader;
  private basePlates: PlateMesh | null = null;
  private lastBaseStats: ReconstructStats | null = null;
  private loadedPast: LoadedPast | null = null;
  private loadedViewBounds: BoundingBox | null = null;
  private ageDirty = false;
  private landLoadTimer = 0;
  private lastLoaded: ViewSnapshot = EMPTY_VIEW;
  private lastQueued: ViewSnapshot = EMPTY_VIEW;
  private lastLoadFile = "";
  private baseReady = false;
  private worldLoadStarted = false;
  private disposed = false;

  /**
   * Create the controller and its two loaders (detail with progress, plate world without).
   *
   * Usage: once at start-up.
   *
   * @param layerDeps - Collaborators.
   */
  constructor(private readonly layerDeps: LandLayerDeps) {
    this.detailLoader = layerDeps.createLoader((loadProgress) => this.handleLoadProgress(loadProgress));
    this.plateWorldLoader = layerDeps.createLoader();
  }

  /**
   * whether disposeLayers() ran.
   *
   * Usage: stop background polling.
   *
   * @returns True after teardown.
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Plate groups of the base layer hidden for lack of rotation poles.
   *
   * Usage: timeline status.
   *
   * @returns Count at the last reconstruction.
   */
  get hiddenPlateGroups(): number {
    return this.lastBaseStats?.noRotation ?? 0;
  }

  /**
   * Mirror detail-loader progress into the progress card and status line.
   *
   * Usage: progress callback of the detail loader.
   *
   * @param loadProgress - Progress record.
   * @returns Nothing.
   */
  private handleLoadProgress(loadProgress: LandLoadProgress): void {
    const isActive = loadProgress.loadPhase !== "idle" && loadProgress.loadPhase !== "done";
    this.showProgress(loadProgress.percentDone, loadProgress.labelText, loadProgress.loadPhase === "done" || isActive);
    if (isActive) this.landStatus = `${loadProgress.labelText} · ${Math.round(loadProgress.percentDone)}%`;
  }

  /**
   * Update the progress card.
   *
   * Usage: load start/end.
   *
   * @param percentDone - Progress 0–100.
   * @param labelText - Status line.
   * @param isVisible - Whether the card is shown.
   * @returns Nothing.
   */
  private showProgress(percentDone: number, labelText: string, isVisible: boolean): void {
    this.layerDeps.progressPanel.updateProgress(percentDone, labelText, isVisible);
  }

  /**
   * React to a new timeline age: re-pose on the next frame, drop age-bound detail.
   *
   * Usage: timeline onAgeChange.
   *
   * @param ageInMyr - New age.
   * @returns Nothing.
   */
  handleAgeChange(ageInMyr: number): void {
    this.ageDirty = true;
    // Detail is valid for one age only; a paused timeline reloads it (scheduleLandLoad).
    if (this.layerDeps.detailSlot.indexCount > 0 || this.loadedPast || (ageInMyr > 0 && this.lastLoadFile !== WORLD_FILE)) {
      this.clearDetail();
    }
  }

  /**
   * Request a re-pose on the next frame.
   *
   * Usage: the rotation model arrived.
   *
   * @returns Nothing.
   */
  markAgeDirty(): void {
    this.ageDirty = true;
  }

  /**
   * Re-pose the plate-tagged base layer for the current age (at most once per frame).
   *
   * Usage: start of every frame.
   *
   * @returns True when the age was applied (callers refresh age-dependent UI).
   */
  applyAge(): boolean {
    if (!this.ageDirty) return false;
    this.ageDirty = false;
    if (this.basePlates) {
      this.lastBaseStats = reconstruct(this.basePlates, this.layerDeps.plateTracker.rotationTree, this.layerDeps.ageSource.currentAgeMa);
      this.layerDeps.baseSlot.uploadPlate(this.basePlates, false);
    }
    return true;
  }

  /**
   * Use a mesh as the base layer, posed for the current age.
   *
   * Usage: world load and plate-tagged world load.
   *
   * @param landMesh - World mesh.
   * @returns Nothing.
   */
  private setBasePlates(landMesh: LandMesh): void {
    this.basePlates = preparePlateMesh(landMesh);
    this.lastBaseStats = reconstruct(this.basePlates, this.layerDeps.plateTracker.rotationTree, this.layerDeps.ageSource.currentAgeMa);
    this.layerDeps.baseSlot.uploadPlate(this.basePlates, true);
    this.layerDeps.onStatusChange();
  }

  /**
   * Swap the base layer for its plate-tagged twin (same land, cut along plates).
   *
   * Usage: once the server finished the world twin.
   *
   * @param twinFile - Plate-tagged world file.
   * @returns Resolves when loaded (or skipped).
   */
  async loadPlateWorld(twinFile: string): Promise<void> {
    const loadResult = await this.plateWorldLoader.loadWorld(twinFile);
    if (this.disposed || !loadResult) return;
    this.setBasePlates(loadResult.landMesh);
    if (this.layerDeps.detailSlot.indexCount === 0) this.landStatus = describeResult("world ", loadResult);
  }

  /**
   * Load the plain world layer once.
   *
   * Usage: first frame (and retries while the API is offline).
   *
   * @returns Resolves when loaded or failed.
   */
  private async ensureWorld(): Promise<void> {
    if (this.disposed || this.baseReady || this.worldLoadStarted) return;
    this.worldLoadStarted = true;
    this.showProgress(0, "Starting…", true);
    this.landStatus = "loading…";
    const loadResult = await this.detailLoader.loadWorld();
    if (this.disposed) return;
    if (!loadResult) {
      this.worldLoadStarted = false;
      this.landStatus = "API offline (run npm run server)";
      this.showProgress(0, "API offline — run npm run server", true);
      return;
    }
    // The plate-tagged world may already have arrived; never replace it with the untagged one.
    const platesFirst = this.basePlates?.isTagged ?? false;
    if (!platesFirst) this.setBasePlates(loadResult.landMesh);
    this.baseReady = true;
    this.lastLoadFile = WORLD_FILE;
    this.landStatus = describeResult("world ", (platesFirst && this.plateWorldLoader.getWorld()) || loadResult);
    this.showProgress(100, this.landStatus, true);
  }

  /**
   * Drop the detail layer and everything cached for it.
   *
   * Usage: zoomed out to the world LOD, age changed, or timeline playing in the past.
   *
   * @returns Nothing.
   */
  private clearDetail(): void {
    this.detailLoader.cancelView();
    this.detailLoader.evictDetail();
    this.layerDeps.detailSlot.clearBuffers();
    this.detailClip = null;
    this.loadedPast = null;
    this.loadedViewBounds = null;
    this.lastLoadFile = WORLD_FILE;
    this.lastLoaded = EMPTY_VIEW;
    this.lastQueued = EMPTY_VIEW;
    if (this.baseReady) {
      const worldResult = this.plateWorldLoader.getWorld() ?? this.detailLoader.getWorld();
      this.landStatus = worldResult ? describeResult("world ", worldResult) : "world";
    }
  }

  /**
   * Cancel a pending delayed load and drop detail that no longer applies.
   *
   * Usage: the view needs no detail.
   *
   * @returns Nothing.
   */
  private dropDetailIfShown(): void {
    window.clearTimeout(this.landLoadTimer);
    if (this.layerDeps.detailSlot.indexCount > 0 || this.lastLoadFile !== WORLD_FILE) this.clearDetail();
  }

  /**
   * Whether a view equals the last queued one (nothing to do).
   *
   * Usage: debounce repeated frames with an unchanged camera.
   *
   * @param viewSnapshot - Current view.
   * @returns True when unchanged.
   */
  private isQueued(viewSnapshot: ViewSnapshot): boolean {
    return (
      viewSnapshot.longitudeDeg === this.lastQueued.longitudeDeg &&
      viewSnapshot.latitudeDeg === this.lastQueued.latitudeDeg &&
      viewSnapshot.heightMeters === this.lastQueued.heightMeters
    );
  }

  /**
   * Decide what land the current view needs and schedule loads.
   *
   * Usage: every frame with the look-at point and camera height.
   *
   * @param longitudeDeg - Look-at longitude.
   * @param latitudeDeg - Look-at latitude.
   * @param heightMeters - Camera height.
   * @returns Nothing.
   */
  scheduleLandLoad(longitudeDeg: number, latitudeDeg: number, heightMeters: number): void {
    if (this.disposed) return;
    void this.ensureWorld();
    const lodFileName = lodFileFromHeight(heightMeters);
    const viewSnapshot: ViewSnapshot = { longitudeDeg, latitudeDeg, heightMeters };
    // In the past each plate has moved: detail comes from the plate-tagged twin of
    // the LOD, per plate, and only while the timeline is paused.
    if (this.layerDeps.ageSource.currentAgeMa > 0) {
      const twinFile = this.layerDeps.plateTracker.plateFiles[lodFileName];
      if (lodFileName === WORLD_FILE || !twinFile || this.layerDeps.ageSource.isPlaying || !this.baseReady) {
        this.dropDetailIfShown();
        return;
      }
      // A changed LOD keeps the previous detail on screen until its replacement is uploaded.
      this.schedulePastLoad(viewSnapshot, lodFileName, twinFile);
      return;
    }
    if (lodFileName === WORLD_FILE) {
      this.dropDetailIfShown();
      return;
    }
    if (!this.baseReady) return;
    this.scheduleViewLoad(viewSnapshot, lodFileName);
  }

  /**
   * Schedule present-day detail when the visible ground left the loaded box.
   *
   * Usage: scheduleLandLoad at a detail LOD and age 0. Loads request a larger
   * padded box, so small pans and zoom-ins need no refetch.
   *
   * @param viewSnapshot - Current view.
   * @param lodFileName - LOD file for the camera height.
   * @returns Nothing.
   */
  private scheduleViewLoad(viewSnapshot: ViewSnapshot, lodFileName: string): void {
    const halfAngle = viewHalfAngle(FIELD_OF_VIEW_Y, this.layerDeps.viewportAspect());
    const visibleBounds = viewBounds(viewSnapshot.longitudeDeg, viewSnapshot.latitudeDeg, viewSnapshot.heightMeters, halfAngle, VISIBLE_MARGIN);
    const needsLoad =
      Number.isNaN(this.lastLoaded.longitudeDeg) ||
      lodFileName !== this.lastLoadFile ||
      !this.loadedViewBounds ||
      !boundsContain(this.loadedViewBounds, visibleBounds, 0);
    if (!needsLoad && this.layerDeps.detailSlot.indexCount > 0) return;
    if (this.isQueued(viewSnapshot)) return;
    this.lastQueued = viewSnapshot;

    window.clearTimeout(this.landLoadTimer);
    this.landLoadTimer = window.setTimeout(() => void this.runViewLoad(viewSnapshot, lodFileName, halfAngle), VIEW_LOAD_DELAY_MS);
  }

  /**
   * Load and upload present-day detail (delayed part of scheduleViewLoad).
   *
   * Usage: timer callback.
   *
   * @param viewSnapshot - View the load was scheduled for.
   * @param lodFileName - Expected LOD file.
   * @param halfAngle - Screen-corner half angle at scheduling time.
   * @returns Resolves when done or dropped.
   */
  private async runViewLoad(viewSnapshot: ViewSnapshot, lodFileName: string, halfAngle: number): Promise<void> {
    if (this.disposed || lodFileFromHeight(this.layerDeps.cameraHeight()) === WORLD_FILE) return;
    this.lastLoaded = viewSnapshot;
    this.showProgress(0, "Starting…", true);
    this.landStatus = "loading…";
    const loadResult = await this.detailLoader.loadView(
      viewSnapshot.longitudeDeg,
      viewSnapshot.latitudeDeg,
      viewSnapshot.heightMeters,
      halfAngle
    );
    if (this.disposed || lodFileFromHeight(this.layerDeps.cameraHeight()) === WORLD_FILE) return;
    if (!loadResult || loadResult.fileName !== lodFileName) return;
    this.showProgress(98, "Uploading GPU buffers…", true);
    this.layerDeps.detailSlot.uploadMesh(loadResult.landMesh);
    this.loadedViewBounds = loadResult.loadedBounds;
    // The base is hidden exactly where the detail data is complete (no overlap band).
    this.detailClip = { clipKind: "bbox", clipBounds: loadResult.loadedBounds };
    this.lastLoadFile = loadResult.fileName;
    this.landStatus = describeResult("", loadResult);
    this.showProgress(100, this.landStatus, true);
  }

  /**
   * Schedule past-age detail around the view centre (paused timeline).
   *
   * Usage: scheduleLandLoad at a detail LOD in the past. The server rotates the view
   * cap back to present-day coordinates per plate; the mesh is reconstructed here.
   *
   * @param viewSnapshot - Current view.
   * @param lodFileName - LOD file for the camera height.
   * @param twinFile - Its plate-tagged twin.
   * @returns Nothing.
   */
  private schedulePastLoad(viewSnapshot: ViewSnapshot, lodFileName: string, twinFile: string): void {
    const halfAngle = viewHalfAngle(FIELD_OF_VIEW_Y, this.layerDeps.viewportAspect());
    const visibleRadius = visibleGroundRadiusDeg(viewSnapshot.heightMeters, halfAngle);
    const ageInMyr = this.layerDeps.ageSource.currentAgeMa;
    const loadedPast = this.loadedPast;
    if (loadedPast && loadedPast.twinFile === twinFile && loadedPast.ageInMyr === ageInMyr && this.layerDeps.detailSlot.indexCount > 0) {
      const centerOffset = angularDistanceDeg(viewSnapshot.longitudeDeg, viewSnapshot.latitudeDeg, loadedPast.centerLon, loadedPast.centerLat);
      // Still inside the loaded cap with a 5 % margin: nothing to do.
      if (centerOffset + visibleRadius * VISIBLE_MARGIN <= loadedPast.radiusDeg) return;
    }
    if (this.isQueued(viewSnapshot)) return;
    this.lastQueued = viewSnapshot;

    window.clearTimeout(this.landLoadTimer);
    this.landLoadTimer = window.setTimeout(
      () => void this.runPastLoad(viewSnapshot, lodFileName, twinFile, ageInMyr, visibleRadius),
      PAST_LOAD_DELAY_MS
    );
  }

  /**
   * Load, reconstruct and upload past-age detail (delayed part of schedulePastLoad).
   *
   * Usage: timer callback.
   *
   * @param viewSnapshot - View the load was scheduled for.
   * @param lodFileName - Expected LOD file.
   * @param twinFile - Plate-tagged twin to query.
   * @param ageInMyr - Age at scheduling time.
   * @param visibleRadius - Visible ground radius in degrees.
   * @returns Resolves when done or dropped.
   */
  private async runPastLoad(
    viewSnapshot: ViewSnapshot,
    lodFileName: string,
    twinFile: string,
    ageInMyr: number,
    visibleRadius: number
  ): Promise<void> {
    const ageSource = this.layerDeps.ageSource;
    const rotationTree = this.layerDeps.plateTracker.rotationTree;
    if (this.disposed || ageSource.isPlaying || ageSource.currentAgeMa !== ageInMyr || !rotationTree) return;
    const radiusDeg = Math.min(90, visibleRadius * PAST_RADIUS_SCALE + PAST_RADIUS_PAD_DEG);
    this.showProgress(0, "Starting…", true);
    this.landStatus = "loading…";
    const heightMeters = viewSnapshot.heightMeters;
    const loadResult = await this.detailLoader.loadPast({
      fileName: twinFile,
      ageInMyr: ageInMyr,
      centerLon: viewSnapshot.longitudeDeg,
      centerLat: viewSnapshot.latitudeDeg,
      radiusDeg,
      cameraHeightM: heightMeters,
      minAreaDeg2: minAreaFromHeight(heightMeters),
      featureLimit: featureLimitFromHeight(heightMeters),
    });
    if (this.disposed || !loadResult || ageSource.currentAgeMa !== ageInMyr || ageSource.isPlaying) return;
    if (lodFileFromHeight(this.layerDeps.cameraHeight()) !== lodFileName) return;
    const detailPlates = preparePlateMesh(loadResult.landMesh);
    reconstruct(detailPlates, rotationTree, ageInMyr);
    this.layerDeps.detailSlot.uploadPlate(detailPlates, true);
    this.loadedPast = {
      twinFile,
      ageInMyr,
      centerLon: viewSnapshot.longitudeDeg,
      centerLat: viewSnapshot.latitudeDeg,
      radiusDeg,
    };
    // Hide the world layer inside the cap the detail fully covers.
    this.detailClip = {
      clipKind: "cap",
      capCenter: lonLatToUnit(viewSnapshot.longitudeDeg, viewSnapshot.latitudeDeg),
      cosRadius: Math.cos((radiusDeg * Math.PI) / 180),
    };
    this.lastLoadFile = lodFileName;
    this.landStatus = describeResult(`${ageInMyr.toFixed(0)} Ma `, loadResult);
    this.showProgress(100, this.landStatus, true);
  }

  /**
   * Stop loading and free GPU buffers.
   *
   * Usage: page teardown.
   *
   * @returns Nothing.
   */
  disposeLayers(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.landLoadTimer);
    this.detailLoader.disposeLoader();
    this.plateWorldLoader.disposeLoader();
    this.layerDeps.detailSlot.destroyBuffers();
    this.layerDeps.baseSlot.destroyBuffers();
    this.detailClip = null;
    this.loadedViewBounds = null;
    this.baseReady = false;
  }
}
