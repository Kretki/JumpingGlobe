/** Load land from the GPKG API (LOD + bbox or past-age cap) and mesh it off the main thread, with caching and cancellation. */

import type { BoundingBox } from "./boundingBox";
import { boundsKey, keyCovers, pastCacheKey } from "./cacheKeys";
import { buildLandUrl, meshPercent, readBodyWithProgress, type PastQuery } from "./landApiClient";
import {
  featureLimitFromHeight,
  lodFileFromHeight,
  meshLodFromFile,
  minAreaFromHeight,
  WORLD_BOUNDS,
  WORLD_FILE,
  type LodLevel,
} from "./lod.config";
import { LruCache } from "./lruCache";
import type { GeoJsonFeatureCollection, LandMesh, MeshStats } from "./meshTypes";
import { MeshWorkerClient, type RequestKind } from "./meshWorkerClient";
import { DEFAULT_VIEW_HALF_ANGLE, viewBounds } from "./viewGeometry";

export type LandLoadResult = {
  landMesh: LandMesh;
  lodLevel: number;
  fileName: string;
  featureCount: number;
  loadedBounds: BoundingBox;
  meshStats?: MeshStats;
};

export type LoadPhase = "idle" | "fetch" | "parse" | "mesh" | "upload" | "done";

export type LandLoadProgress = {
  percentDone: number;
  loadPhase: LoadPhase;
  labelText: string;
  doneCount?: number;
  totalCount?: number;
};

export type LandProgressFn = (loadProgress: LandLoadProgress) => void;

/** Past-age detail request: view cap plus file and request limits. */
export type PastLoadRequest = PastQuery & { fileName: string; cameraHeightM: number; minAreaDeg2: number; featureLimit: number };

type LoadRequest = {
  requestKind: RequestKind;
  fileName: string;
  requestBounds: BoundingBox;
  minAreaDeg2: number;
  featureLimit: number;
  cacheKey?: string;
  cameraHeightM?: number;
  /** Past-time detail: /land/past around a reconstructed view centre. */
  pastQuery?: PastQuery;
};

const VIEW_CACHE_SIZE = 8;
const WORLD_MIN_AREA = 0.5;
const WORLD_FEATURE_LIMIT = 8_000;

export class LandLoader {
  private readonly viewCache = new LruCache<LandLoadResult>(VIEW_CACHE_SIZE);
  private readonly workerClient: MeshWorkerClient;
  private readonly apiBaseUrl: string;
  private worldResult: LandLoadResult | null = null;
  private inflightWorld: AbortController | null = null;
  private inflightView: AbortController | null = null;
  private lastViewKey = "";
  private worldSequence = 0;
  private viewSequence = 0;
  private isDisposed = false;
  private onProgress: LandProgressFn | null;

  /**
   * Create a loader with its own mesh worker.
   *
   * Usage: ``new LandLoader("/api", progress => ...)``.
   *
   * @param apiBaseUrl - API prefix (a trailing slash is removed).
   * @param onProgress - Optional progress callback.
   */
  constructor(apiBaseUrl = "/api", onProgress?: LandProgressFn) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.onProgress = onProgress ?? null;
    this.workerClient = new MeshWorkerClient((requestKind, sequenceId, doneCount, totalCount) => {
      if (sequenceId !== this.activeSequence(requestKind)) return;
      this.emitProgress({
        percentDone: Math.round(meshPercent(doneCount, totalCount)),
        loadPhase: "mesh",
        labelText: `Meshing features ${doneCount}/${totalCount}`,
        doneCount,
        totalCount,
      });
    });
  }

  /**
   * Forward progress to the callback.
   *
   * Usage: every load step.
   *
   * @param loadProgress - Progress record.
   * @returns Nothing.
   */
  private emitProgress(loadProgress: LandLoadProgress): void {
    this.onProgress?.(loadProgress);
  }

  /**
   * Latest sequence number of a request kind.
   *
   * Usage: drop results of superseded requests.
   *
   * @param requestKind - "world" or "view".
   * @returns The active sequence number.
   */
  private activeSequence(requestKind: RequestKind): number {
    return requestKind === "world" ? this.worldSequence : this.viewSequence;
  }

  /**
   * Whether a request was superseded or the loader disposed.
   *
   * Usage: checked after every await.
   *
   * @param requestKind - Kind of the request.
   * @param sequenceId - Its sequence number.
   * @returns True when its result must be dropped.
   */
  private isStaleRequest(requestKind: RequestKind, sequenceId: number): boolean {
    return sequenceId !== this.activeSequence(requestKind) || this.isDisposed;
  }

  /**
   * Remember a finished result.
   *
   * Usage: after meshing succeeded.
   *
   * @param requestKind - "world" keeps the single world result; "view" uses the LRU cache.
   * @param cacheKey - Cache key of a view result.
   * @param loadResult - Result to store.
   * @returns Nothing.
   */
  private storeResult(requestKind: RequestKind, cacheKey: string, loadResult: LandLoadResult): void {
    if (requestKind === "world") {
      this.worldResult = loadResult;
    } else {
      this.viewCache.setEntry(cacheKey, loadResult);
      this.lastViewKey = cacheKey;
    }
  }

  /**
   * The loaded world layer, if any.
   *
   * Usage: status text and fallbacks.
   *
   * @returns The world result or null.
   */
  getWorld(): LandLoadResult | null {
    return this.worldResult;
  }

  /**
   * Load a whole-world layer (the LOD0 base by default, or its plate-tagged twin).
   *
   * Usage: once at start-up and when the plate-tagged world becomes available.
   *
   * @param fileName - GeoPackage to load.
   * @param minAreaDeg2 - Minimum envelope area in deg².
   * @param featureLimit - Maximum number of features.
   * @returns The result (cached after the first load), or null on failure/cancel.
   */
  async loadWorld(fileName = WORLD_FILE, minAreaDeg2 = WORLD_MIN_AREA, featureLimit = WORLD_FEATURE_LIMIT): Promise<LandLoadResult | null> {
    if (this.isDisposed) return null;
    if (this.worldResult && this.worldResult.fileName === fileName) {
      this.emitProgress({ percentDone: 100, loadPhase: "done", labelText: "Cached" });
      return this.worldResult;
    }
    return this.fetchAndMesh({ requestKind: "world", fileName, requestBounds: WORLD_BOUNDS, minAreaDeg2, featureLimit });
  }

  /**
   * Load present-day detail for a view.
   *
   * Usage: whenever the camera settles at a detail LOD.
   *
   * @param longitudeDeg - Nadir longitude.
   * @param latitudeDeg - Nadir latitude.
   * @param cameraHeightM - Camera height.
   * @param halfAngleRad - Screen-corner half angle.
   * @returns The result (possibly cached or a covering earlier view), or null.
   */
  async loadView(
    longitudeDeg: number,
    latitudeDeg: number,
    cameraHeightM: number,
    halfAngleRad = DEFAULT_VIEW_HALF_ANGLE
  ): Promise<LandLoadResult | null> {
    if (this.isDisposed) return null;
    const fileName = lodFileFromHeight(cameraHeightM);
    if (fileName === WORLD_FILE) return this.worldResult;
    const requestBounds = viewBounds(longitudeDeg, latitudeDeg, cameraHeightM, halfAngleRad);
    const minAreaDeg2 = minAreaFromHeight(cameraHeightM);
    const featureLimit = featureLimitFromHeight(cameraHeightM);
    const cacheKey = boundsKey(requestBounds, fileName, minAreaDeg2);

    const cachedResult = this.viewCache.getEntry(cacheKey);
    if (cachedResult) {
      this.lastViewKey = cacheKey;
      this.emitProgress({ percentDone: 100, loadPhase: "done", labelText: "Cached" });
      return cachedResult;
    }
    if (this.lastViewKey && keyCovers(this.lastViewKey, cacheKey)) {
      const previousResult = this.viewCache.getEntry(this.lastViewKey);
      if (previousResult && previousResult.fileName === fileName) {
        this.emitProgress({ percentDone: 100, loadPhase: "done", labelText: "Cached" });
        return previousResult;
      }
    }
    return this.fetchAndMesh({ requestKind: "view", fileName, requestBounds, minAreaDeg2, featureLimit, cacheKey, cameraHeightM });
  }

  /**
   * Load detail around a view centre as it was at an age (paused timeline).
   *
   * Usage: past-age detail; the mesh stays in present-day coordinates, plate-tagged,
   * to be reconstructed by the caller.
   *
   * @param pastRequest - View cap, age, file and limits.
   * @returns The result (cached per cap), or null.
   */
  async loadPast(pastRequest: PastLoadRequest): Promise<LandLoadResult | null> {
    if (this.isDisposed) return null;
    const cacheKey = pastCacheKey(pastRequest.fileName, pastRequest);
    const cachedResult = this.viewCache.getEntry(cacheKey);
    if (cachedResult) return cachedResult;
    const capBounds = viewBounds(pastRequest.centerLon, pastRequest.centerLat, 0, undefined, 1);
    return this.fetchAndMesh({
      requestKind: "view",
      fileName: pastRequest.fileName,
      requestBounds: {
        ...capBounds,
        southEdge: Math.max(-90, pastRequest.centerLat - pastRequest.radiusDeg),
        northEdge: Math.min(90, pastRequest.centerLat + pastRequest.radiusDeg),
      },
      minAreaDeg2: pastRequest.minAreaDeg2,
      featureLimit: pastRequest.featureLimit,
      cacheKey,
      cameraHeightM: pastRequest.cameraHeightM,
      pastQuery: pastRequest,
    });
  }

  /**
   * Cancel the in-flight view load (download and meshing).
   *
   * Usage: the view moved to the world LOD or the age changed.
   *
   * @returns Nothing.
   */
  cancelView(): void {
    this.viewSequence++;
    this.inflightView?.abort();
    this.inflightView = null;
    const worldPending = this.workerClient.cancelKind("view");
    if (!worldPending) this.workerClient.restartWorker();
    this.emitProgress({ percentDone: 0, loadPhase: "idle", labelText: "Idle" });
  }

  /**
   * Drop all cached detail.
   *
   * Usage: detail is only valid for one age.
   *
   * @returns Nothing.
   */
  evictDetail(): void {
    this.viewCache.clearAll();
    this.lastViewKey = "";
  }

  /**
   * Abort everything and release the worker.
   *
   * Usage: page teardown.
   *
   * @returns Nothing.
   */
  disposeLoader(): void {
    this.isDisposed = true;
    this.inflightWorld?.abort();
    this.inflightView?.abort();
    this.inflightWorld = null;
    this.inflightView = null;
    this.worldSequence++;
    this.viewSequence++;
    this.workerClient.disposeWorker();
    this.viewCache.clearAll();
    this.worldResult = null;
    this.lastViewKey = "";
    this.onProgress = null;
  }

  /**
   * Download, parse and mesh one request.
   *
   * Usage: shared by loadWorld, loadView and loadPast.
   *
   * @param loadRequest - What to load.
   * @returns The result, or null when superseded, aborted or failed.
   */
  private async fetchAndMesh(loadRequest: LoadRequest): Promise<LandLoadResult | null> {
    const { requestKind, fileName, requestBounds, minAreaDeg2, featureLimit, pastQuery } = loadRequest;
    const lodLevel: LodLevel = meshLodFromFile(fileName);
    const cacheKey = loadRequest.cacheKey ?? boundsKey(requestBounds, fileName, minAreaDeg2);

    if (requestKind === "view" && this.inflightView) this.inflightView.abort();
    const abortControl = new AbortController();
    if (requestKind === "world") this.inflightWorld = abortControl;
    else this.inflightView = abortControl;
    const sequenceId = requestKind === "world" ? ++this.worldSequence : ++this.viewSequence;
    // Past features carry their own per-plate clip boxes; no global clip then.
    const meshClip = requestKind === "view" && !pastQuery ? requestBounds : undefined;
    const cameraHeightM = requestKind === "view" ? loadRequest.cameraHeightM : undefined;

    try {
      this.emitProgress({ percentDone: 0, loadPhase: "fetch", labelText: "Fetching land…" });
      const requestUrl = buildLandUrl(this.apiBaseUrl, fileName, requestBounds, featureLimit, minAreaDeg2, pastQuery);
      const httpResponse = await fetch(requestUrl, { signal: abortControl.signal });
      if (!httpResponse.ok) {
        console.warn("land API", httpResponse.status, await httpResponse.text());
        this.emitProgress({ percentDone: 0, loadPhase: "idle", labelText: "API error" });
        return null;
      }
      if (this.isStaleRequest(requestKind, sequenceId)) return null;

      const bodyText = await readBodyWithProgress(httpResponse, abortControl.signal, (percentDone, labelText) =>
        this.emitProgress({ percentDone, loadPhase: "fetch", labelText })
      );
      if (this.isStaleRequest(requestKind, sequenceId)) return null;

      this.emitProgress({ percentDone: 37, loadPhase: "parse", labelText: "Parsing GeoJSON…" });
      const featureCollection = JSON.parse(bodyText) as GeoJsonFeatureCollection;
      const featureCount = featureCollection.count ?? featureCollection.features.length;
      this.emitProgress({
        percentDone: 40,
        loadPhase: "mesh",
        labelText: `Meshing ${featureCount} features…`,
        doneCount: 0,
        totalCount: featureCount,
      });

      const landMesh = this.workerClient.isAvailable
        ? await this.meshInWorker(requestKind, sequenceId, lodLevel, featureCollection, meshClip, cameraHeightM)
        : await this.meshOnMainThread(requestKind, sequenceId, lodLevel, featureCollection, meshClip, cameraHeightM);
      if (!landMesh) return null;

      this.emitProgress({ percentDone: 96, loadPhase: "upload", labelText: "Uploading mesh…" });
      const loadResult: LandLoadResult = {
        landMesh,
        lodLevel,
        fileName,
        featureCount,
        loadedBounds: requestBounds,
        meshStats: landMesh.meshStats,
      };
      this.storeResult(requestKind, cacheKey, loadResult);
      this.emitProgress({ percentDone: 100, loadPhase: "done", labelText: "Done" });
      return loadResult;
    } catch (caughtError) {
      if ((caughtError as Error).name === "AbortError") return null;
      console.warn("land load failed", caughtError);
      this.emitProgress({ percentDone: 0, loadPhase: "idle", labelText: "Load failed" });
      return null;
    } finally {
      if (requestKind === "world" && this.inflightWorld === abortControl) this.inflightWorld = null;
      if (requestKind === "view" && this.inflightView === abortControl) this.inflightView = null;
    }
  }

  /**
   * Mesh a FeatureCollection in the worker.
   *
   * Usage: normal path of fetchAndMesh.
   *
   * @param requestKind - Kind of the request.
   * @param sequenceId - Its sequence number.
   * @param lodLevel - LOD of the source file.
   * @param featureCollection - Parsed features.
   * @param clipBounds - Clip box, if any.
   * @param cameraHeightM - Camera height for view requests.
   * @returns The mesh, or null when superseded or failed.
   */
  private async meshInWorker(
    requestKind: RequestKind,
    sequenceId: number,
    lodLevel: number,
    featureCollection: GeoJsonFeatureCollection,
    clipBounds?: BoundingBox,
    cameraHeightM?: number
  ): Promise<LandMesh | null> {
    const workerResult = await this.workerClient.submitRequest(requestKind, {
      sequenceId,
      lodLevel,
      featureCollection,
      clipBounds,
      cameraHeightM,
    });
    if (!workerResult || sequenceId !== this.activeSequence(requestKind)) return null;
    if (!workerResult.succeeded) {
      console.warn("land mesh failed", workerResult.errorText);
      this.emitProgress({ percentDone: 0, loadPhase: "idle", labelText: "Mesh failed" });
      return null;
    }
    return workerResult.landMesh;
  }

  /**
   * Mesh a FeatureCollection on the main thread (no Worker support).
   *
   * Usage: fallback path of fetchAndMesh.
   *
   * @param requestKind - Kind of the request.
   * @param sequenceId - Its sequence number.
   * @param lodLevel - LOD of the source file.
   * @param featureCollection - Parsed features.
   * @param clipBounds - Clip box, if any.
   * @param cameraHeightM - Camera height for view requests.
   * @returns The mesh, or null when superseded.
   */
  private async meshOnMainThread(
    requestKind: RequestKind,
    sequenceId: number,
    lodLevel: number,
    featureCollection: GeoJsonFeatureCollection,
    clipBounds?: BoundingBox,
    cameraHeightM?: number
  ): Promise<LandMesh | null> {
    const { featureCollectionToMesh } = await import("./meshBuilder");
    if (this.isStaleRequest(requestKind, sequenceId)) return null;
    return featureCollectionToMesh(
      featureCollection,
      lodLevel,
      (doneCount, totalCount) => {
        if (sequenceId !== this.activeSequence(requestKind)) return;
        this.emitProgress({
          percentDone: Math.round(meshPercent(doneCount, totalCount)),
          loadPhase: "mesh",
          labelText: `Meshing features ${doneCount}/${totalCount}`,
          doneCount,
          totalCount,
        });
      },
      requestKind === "view" ? { clipBounds, cameraHeightM } : undefined
    );
  }
}
