/** Web Worker: FeatureCollection → ECEF land mesh (transferable buffers). */

import {
  featureCollectionToMesh,
  type GeoJsonFeatureCollection,
  type MeshBBox,
  type MeshStats,
} from "./mesh";

export type MeshWorkerRequest = {
  seq: number;
  lod: number;
  fc: GeoJsonFeatureCollection;
  bbox?: MeshBBox;
  heightM?: number;
};

export type MeshWorkerProgress = {
  type: "progress";
  seq: number;
  phase: "mesh";
  done: number;
  total: number;
  percent: number;
};

export type MeshWorkerResponse =
  | {
      type: "result";
      seq: number;
      ok: true;
      positions: Float32Array;
      normals: Float32Array;
      indices: Uint32Array;
      featureCount: number;
      triangleCount: number;
      stats: MeshStats;
    }
  | {
      type: "result";
      seq: number;
      ok: false;
      error: string;
    }
  | MeshWorkerProgress;

self.onmessage = (ev: MessageEvent<MeshWorkerRequest>) => {
  const { seq, lod, fc, bbox, heightM } = ev.data;
  try {
    let lastEmit = 0;
    const mesh = featureCollectionToMesh(
      fc,
      lod,
      (done, total) => {
        const now = Date.now();
        if (done < total && now - lastEmit < 40) return;
        lastEmit = now;
        const percent = total > 0 ? Math.round((done / total) * 100) : 100;
        const prog: MeshWorkerProgress = {
          type: "progress",
          seq,
          phase: "mesh",
          done,
          total,
          percent,
        };
        (self as unknown as Worker).postMessage(prog);
      },
      { bbox, heightM }
    );
    const res: MeshWorkerResponse = {
      type: "result",
      seq,
      ok: true,
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
      featureCount: mesh.featureCount,
      triangleCount: mesh.triangleCount,
      stats: mesh.stats,
    };
    const transfer: ArrayBuffer[] = [
      mesh.positions.buffer as ArrayBuffer,
      mesh.normals.buffer as ArrayBuffer,
      mesh.indices.buffer as ArrayBuffer,
    ];
    (self as unknown as Worker).postMessage(res, transfer);
  } catch (err) {
    const res: MeshWorkerResponse = {
      type: "result",
      seq,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(res);
  }
};
