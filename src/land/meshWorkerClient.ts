/** Main-thread side of the mesh worker: request bookkeeping, cancellation and restarts. */

import type { MeshWorkerRequest, MeshWorkerResponse, MeshWorkerResult } from "./meshWorker";

/** Requests of one kind supersede each other; the other kind is independent. */
export type RequestKind = "world" | "view";

export type WorkerProgressFn = (requestKind: RequestKind, sequenceId: number, doneCount: number, totalCount: number) => void;

type PendingRequest = { requestKind: RequestKind; resolveResult: (workerResult: MeshWorkerResult | null) => void };

export class MeshWorkerClient {
  private meshWorker: Worker | null = null;
  private readonly pendingRequests = new Map<number, PendingRequest>();

  /**
   * Start the worker.
   *
   * Usage: ``new MeshWorkerClient(onProgress)``; falls back to unavailable when
   * workers cannot be created (callers then mesh on the main thread).
   *
   * @param onProgress - Called for progress messages of pending requests.
   */
  constructor(private readonly onProgress: WorkerProgressFn) {
    this.startWorker();
  }

  /**
   * Whether requests can be sent.
   *
   * Usage: choose between worker and main-thread meshing.
   *
   * @returns True while a worker is running.
   */
  get isAvailable(): boolean {
    return this.meshWorker !== null;
  }

  /**
   * Create the worker and wire its handlers.
   *
   * Usage: construction and restarts.
   *
   * @returns Nothing.
   */
  private startWorker(): void {
    try {
      this.meshWorker = new Worker(new URL("./meshWorker.ts", import.meta.url), { type: "module" });
      this.meshWorker.onmessage = (messageEvent: MessageEvent<MeshWorkerResponse>) => this.handleMessage(messageEvent.data);
      this.meshWorker.onerror = (errorEvent) => console.warn("land mesh worker error", errorEvent);
    } catch (caughtError) {
      console.warn("land mesh worker unavailable, meshing on main thread", caughtError);
      this.meshWorker = null;
    }
  }

  /**
   * Route a worker message to its pending request.
   *
   * Usage: worker onmessage handler.
   *
   * @param workerMessage - Progress or result message.
   * @returns Nothing.
   */
  private handleMessage(workerMessage: MeshWorkerResponse): void {
    const pendingRequest = this.pendingRequests.get(workerMessage.sequenceId);
    if (!pendingRequest) return;
    if (workerMessage.messageKind === "progress") {
      this.onProgress(pendingRequest.requestKind, workerMessage.sequenceId, workerMessage.doneCount, workerMessage.totalCount);
      return;
    }
    this.pendingRequests.delete(workerMessage.sequenceId);
    pendingRequest.resolveResult(workerMessage);
  }

  /**
   * Send a mesh request, superseding older requests of the same kind.
   *
   * Usage: one call per load.
   *
   * @param requestKind - "world" or "view".
   * @param meshRequest - Request payload (sequenceId must increase per kind).
   * @returns The worker's result, or null when superseded or cancelled.
   */
  submitRequest(requestKind: RequestKind, meshRequest: MeshWorkerRequest): Promise<MeshWorkerResult | null> {
    return new Promise((resolveResult) => {
      for (const [sequenceId, pendingRequest] of this.pendingRequests) {
        if (pendingRequest.requestKind === requestKind && sequenceId < meshRequest.sequenceId) {
          pendingRequest.resolveResult(null);
          this.pendingRequests.delete(sequenceId);
        }
      }
      this.pendingRequests.set(meshRequest.sequenceId, { requestKind, resolveResult });
      this.meshWorker!.postMessage(meshRequest);
    });
  }

  /**
   * Cancel all pending requests of one kind.
   *
   * Usage: the view changed and its detail is no longer wanted.
   *
   * @param requestKind - Kind to cancel.
   * @returns True when requests of the other kind are still pending.
   */
  cancelKind(requestKind: RequestKind): boolean {
    let otherPending = false;
    for (const [sequenceId, pendingRequest] of this.pendingRequests) {
      if (pendingRequest.requestKind === requestKind) {
        pendingRequest.resolveResult(null);
        this.pendingRequests.delete(sequenceId);
      } else {
        otherPending = true;
      }
    }
    return otherPending;
  }

  /**
   * Terminate the worker (aborting its current job) and start a fresh one.
   *
   * Usage: after cancelKind when nothing else is pending.
   *
   * @returns Nothing.
   */
  restartWorker(): void {
    if (!this.meshWorker) return;
    this.meshWorker.terminate();
    this.meshWorker = null;
    this.startWorker();
  }

  /**
   * Cancel everything and stop the worker for good.
   *
   * Usage: page teardown.
   *
   * @returns Nothing.
   */
  disposeWorker(): void {
    for (const pendingRequest of this.pendingRequests.values()) pendingRequest.resolveResult(null);
    this.pendingRequests.clear();
    this.meshWorker?.terminate();
    this.meshWorker = null;
  }
}
