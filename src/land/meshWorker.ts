/** Web Worker: FeatureCollection → ECEF land mesh (typed arrays are transferred, not copied). */

import type { BoundingBox } from "./boundingBox";
import { featureCollectionToMesh } from "./meshBuilder";
import type { GeoJsonFeatureCollection, LandMesh } from "./meshTypes";

export type MeshWorkerRequest = {
  sequenceId: number;
  lodLevel: number;
  featureCollection: GeoJsonFeatureCollection;
  clipBounds?: BoundingBox;
  cameraHeightM?: number;
};

export type MeshWorkerProgress = {
  messageKind: "progress";
  sequenceId: number;
  doneCount: number;
  totalCount: number;
  percentDone: number;
};

export type MeshWorkerResult =
  | { messageKind: "result"; sequenceId: number; succeeded: true; landMesh: LandMesh }
  | { messageKind: "result"; sequenceId: number; succeeded: false; errorText: string };

export type MeshWorkerResponse = MeshWorkerResult | MeshWorkerProgress;

const PROGRESS_INTERVAL_MS = 40;

/**
 * Post a message from the worker, optionally transferring buffers.
 *
 * Usage: every response of this worker.
 *
 * @param workerMessage - Response to send.
 * @param transferList - Buffers to transfer.
 * @returns Nothing.
 */
function postToMain(workerMessage: MeshWorkerResponse, transferList: ArrayBuffer[] = []): void {
  (self as unknown as Worker).postMessage(workerMessage, transferList);
}

/**
 * Mesh one request and post progress messages and the result.
 *
 * Usage: the worker's message handler.
 *
 * @param meshRequest - Request from MeshWorkerClient.
 * @returns Nothing.
 */
function handleRequest(meshRequest: MeshWorkerRequest): void {
  const { sequenceId, lodLevel, featureCollection, clipBounds, cameraHeightM } = meshRequest;
  try {
    let lastEmitMs = 0;
    const landMesh = featureCollectionToMesh(
      featureCollection,
      lodLevel,
      (doneCount, totalCount) => {
        const nowMillis = Date.now();
        if (doneCount < totalCount && nowMillis - lastEmitMs < PROGRESS_INTERVAL_MS) return;
        lastEmitMs = nowMillis;
        const percentDone = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 100;
        postToMain({ messageKind: "progress", sequenceId, doneCount, totalCount, percentDone });
      },
      { clipBounds, cameraHeightM }
    );
    postToMain({ messageKind: "result", sequenceId, succeeded: true, landMesh }, [
      landMesh.positions.buffer as ArrayBuffer,
      landMesh.vertexNormals.buffer as ArrayBuffer,
      landMesh.triangleIndices.buffer as ArrayBuffer,
      landMesh.groupIdx.buffer as ArrayBuffer,
    ]);
  } catch (caughtError) {
    const errorText = caughtError instanceof Error ? caughtError.message : String(caughtError);
    postToMain({ messageKind: "result", sequenceId, succeeded: false, errorText });
  }
}

self.onmessage = (messageEvent: MessageEvent<MeshWorkerRequest>) => handleRequest(messageEvent.data);
