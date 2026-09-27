/** Fetch land polygons from the GPKG API (LOD + bbox, EPSG:4326) and mesh off-thread. */

import type { GeoJsonFeatureCollection, LandMesh, MeshStats } from "./mesh";
import type { MeshWorkerRequest, MeshWorkerResponse } from "./meshWorker";
import {
  WORLD_BBOX,
  WORLD_FILE,
  lodFileFromHeight,
  maxSpanFromHeight,
  meshLodFromFile,
  meshLodFromHeight,
  type LandLod,
} from "./lod.config";

export {
  lodFileFromHeight,
  lodFromHeight,
  maxSpanFromHeight,
  meshLodFromFile,
  meshLodFromHeight,
  WORLD_FILE,
  WORLD_BBOX,
} from "./lod.config";
export type { LandLod, LodHeightBand } from "./lod.config";

export type BBox = { west: number; south: number; east: number; north: number };

export type LandLoadResult = {
  mesh: LandMesh;
  lod: number;
  file: string;
  count: number;
  bbox: BBox;
  stats?: MeshStats;
};

export type LandLoadProgress = {
  percent: number;
  phase: "idle" | "fetch" | "parse" | "mesh" | "upload" | "done";
  label: string;
  done?: number;
  total?: number;
};

export type LandProgressFn = (p: LandLoadProgress) => void;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function minAreaFromHeight(heightM: number): number {
  if (heightM > 8_000_000) return 0.5;
  if (heightM > 3_000_000) return 0.05;
  if (heightM > 1_000_000) return 0.005;
  if (heightM > 300_000) return 0.0005;
  return 0;
}

export function featureLimitFromHeight(heightM: number): number {
  if (heightM > 3_000_000) return 4_000;
  if (heightM > 1_000_000) return 5_000;
  return 6_000;
}

export function viewBBox(
  lonDeg: number,
  latDeg: number,
  heightM: number,
  padScale = 1.35,
  maxSpanDeg = maxSpanFromHeight(heightM)
): BBox {
  const R = 6_371_000;
  const ang = Math.acos(clamp(R / (R + Math.max(heightM, 1)), -1, 1));
  const maxHalf = maxSpanDeg / 2;
  let halfLon = ((ang * 180) / Math.PI) * padScale;
  let halfLat = halfLon * padScale;
  const cosLat = Math.max(0.15, Math.cos((latDeg * Math.PI) / 180));
  halfLon = Math.min(maxHalf, halfLon / cosLat);
  halfLat = Math.min(maxHalf, halfLat);

  let south = clamp(latDeg - halfLat, -85, 85);
  let north = clamp(latDeg + halfLat, -85, 85);
  let west = lonDeg - halfLon;
  let east = lonDeg + halfLon;

  const norm = (L: number) => {
    let x = ((((L + 180) % 360) + 360) % 360) - 180;
    return x;
  };
  west = norm(west);
  east = norm(east);

  return { west, south, east, north };
}

function bboxKey(b: BBox, file: string, minArea: number): string {
  const q = (n: number) => n.toFixed(2);
  return `${file}|${q(b.west)},${q(b.south)},${q(b.east)},${q(b.north)}|${minArea.toFixed(4)}`;
}

class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private cap: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.cap) {
      const first = this.map.keys().next().value as string;
      this.map.delete(first);
    }
  }

  clear() {
    this.map.clear();
  }

  deleteMatching(pred: (key: string) => boolean) {
    for (const k of [...this.map.keys()]) {
      if (pred(k)) this.map.delete(k);
    }
  }

  get size() {
    return this.map.size;
  }
}

function mapFetchPercent(bytes: number, total: number | null): number {
  if (total && total > 0) return clamp((bytes / total) * 35, 0, 35);
  return clamp(30 * (1 - Math.exp(-bytes / 2e6)), 0, 30);
}

function mapMeshPercent(done: number, total: number): number {
  const t = total > 0 ? done / total : 1;
  return 40 + t * 55;
}

type PendingKind = "world" | "view";

export class LandLoader {
  private viewCache = new LruCache<LandLoadResult>(8);
  private worldResult: LandLoadResult | null = null;
  private inflightWorld: AbortController | null = null;
  private inflightView: AbortController | null = null;
  private lastViewKey = "";
  private baseUrl: string;
  private worker: Worker | null = null;
  private worldSeq = 0;
  private viewSeq = 0;
  private pendingMesh = new Map<
    number,
    {
      kind: PendingKind;
      key: string;
      lod: number;
      file: string;
      count: number;
      bbox: BBox;
      resolve: (r: LandLoadResult | null) => void;
    }
  >();
  private workerReady = false;
  private disposed = false;
  private onProgress: LandProgressFn | null = null;

  constructor(baseUrl = "/api", onProgress?: LandProgressFn) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.onProgress = onProgress ?? null;
    this.initWorker();
  }

  setProgressHandler(fn: LandProgressFn | null) {
    this.onProgress = fn;
  }

  private emit(p: LandLoadProgress) {
    this.onProgress?.(p);
  }

  private initWorker() {
    try {
      this.worker = new Worker(new URL("./meshWorker.ts", import.meta.url), {
        type: "module",
      });
      this.worker.onmessage = (ev: MessageEvent<MeshWorkerResponse>) => {
        this.onWorkerMessage(ev.data);
      };
      this.worker.onerror = (err) => {
        console.warn("land mesh worker error", err);
      };
      this.workerReady = true;
    } catch (err) {
      console.warn("land mesh worker unavailable, meshing on main thread", err);
      this.worker = null;
      this.workerReady = false;
    }
  }

  private activeSeq(kind: PendingKind): number {
    return kind === "world" ? this.worldSeq : this.viewSeq;
  }

  private onWorkerMessage(data: MeshWorkerResponse) {
    if (data.type === "progress") {
      const pending = this.pendingMesh.get(data.seq);
      if (!pending || data.seq !== this.activeSeq(pending.kind)) return;
      const overall = Math.round(mapMeshPercent(data.done, data.total));
      this.emit({
        percent: overall,
        phase: "mesh",
        label: `Meshing features ${data.done}/${data.total}`,
        done: data.done,
        total: data.total,
      });
      return;
    }

    const pending = this.pendingMesh.get(data.seq);
    if (!pending) return;
    this.pendingMesh.delete(data.seq);

    if (data.seq !== this.activeSeq(pending.kind)) {
      pending.resolve(null);
      return;
    }

    if (!data.ok) {
      console.warn("land mesh failed", data.error);
      this.emit({ percent: 0, phase: "idle", label: "Mesh failed" });
      pending.resolve(null);
      return;
    }

    this.emit({ percent: 96, phase: "upload", label: "Uploading mesh…" });

    const mesh: LandMesh = {
      positions: data.positions,
      normals: data.normals,
      indices: data.indices,
      featureCount: data.featureCount,
      triangleCount: data.triangleCount,
      stats: data.stats,
    };
    const result: LandLoadResult = {
      mesh,
      lod: pending.lod,
      file: pending.file,
      count: pending.count,
      bbox: pending.bbox,
      stats: data.stats,
    };
    this.storeResult(pending.kind, pending.key, result);
    this.emit({ percent: 100, phase: "done", label: "Done" });
    pending.resolve(result);
  }

  private storeResult(kind: PendingKind, key: string, result: LandLoadResult) {
    if (kind === "world") {
      this.worldResult = result;
    } else {
      this.viewCache.set(key, result);
      this.lastViewKey = key;
    }
  }

  getWorld(): LandLoadResult | null {
    return this.worldResult;
  }

  async loadWorld(): Promise<LandLoadResult | null> {
    if (this.disposed) return null;
    if (this.worldResult) {
      this.emit({ percent: 100, phase: "done", label: "Cached" });
      return this.worldResult;
    }
    return this.fetchAndMesh({
      kind: "world",
      file: WORLD_FILE,
      bbox: WORLD_BBOX,
      minArea: 0.5,
      limit: 8_000,
    });
  }

  async loadView(lonDeg: number, latDeg: number, heightM: number): Promise<LandLoadResult | null> {
    if (this.disposed) return null;
    const file = lodFileFromHeight(heightM);
    if (file === WORLD_FILE) return this.worldResult;
    const bbox = viewBBox(lonDeg, latDeg, heightM);
    const minArea = minAreaFromHeight(heightM);
    const limit = featureLimitFromHeight(heightM);
    const key = bboxKey(bbox, file, minArea);

    const cached = this.viewCache.get(key);
    if (cached) {
      this.lastViewKey = key;
      this.emit({ percent: 100, phase: "done", label: "Cached" });
      return cached;
    }

    if (this.lastViewKey && this.similarKey(this.lastViewKey, key)) {
      const prev = this.viewCache.get(this.lastViewKey);
      if (prev && prev.file === file) {
        this.emit({ percent: 100, phase: "done", label: "Cached" });
        return prev;
      }
    }

    return this.fetchAndMesh({
      kind: "view",
      file,
      bbox,
      minArea,
      limit,
      key,
      heightM,
    });
  }

  cancelView() {
    this.viewSeq++;
    if (this.inflightView) {
      this.inflightView.abort();
      this.inflightView = null;
    }
    let worldPending = false;
    for (const [s, p] of this.pendingMesh) {
      if (p.kind === "view") {
        p.resolve(null);
        this.pendingMesh.delete(s);
      } else {
        worldPending = true;
      }
    }
    if (!worldPending && this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.workerReady = false;
      this.initWorker();
    }
    this.emit({ percent: 0, phase: "idle", label: "Idle" });
  }

  evictDetail() {
    this.viewCache.clear();
    this.lastViewKey = "";
  }

  dispose() {
    this.disposed = true;
    this.inflightWorld?.abort();
    this.inflightView?.abort();
    this.inflightWorld = null;
    this.inflightView = null;
    this.worldSeq++;
    this.viewSeq++;
    for (const p of this.pendingMesh.values()) p.resolve(null);
    this.pendingMesh.clear();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.workerReady = false;
    }
    this.viewCache.clear();
    this.worldResult = null;
    this.lastViewKey = "";
    this.onProgress = null;
  }

  private async fetchAndMesh(opts: {
    kind: PendingKind;
    file: string;
    bbox: BBox;
    minArea: number;
    limit: number;
    key?: string;
    heightM?: number;
  }): Promise<LandLoadResult | null> {
    const file = opts.file;
    const bbox = opts.bbox;
    const minArea = opts.minArea;
    const limit = opts.limit;
    const lod: LandLod = meshLodFromFile(file);
    const key = opts.key ?? bboxKey(bbox, file, minArea);
    const kind = opts.kind;

    if (kind === "view" && this.inflightView) this.inflightView.abort();
    const ac = new AbortController();
    if (kind === "world") this.inflightWorld = ac;
    else this.inflightView = ac;

    const mySeq = kind === "world" ? ++this.worldSeq : ++this.viewSeq;

    const params = new URLSearchParams({
      file,
      bbox: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
      limit: String(limit),
      min_area: String(minArea),
    });

    try {
      this.emit({ percent: 0, phase: "fetch", label: "Fetching land…" });

      const res = await fetch(`${this.baseUrl}/land?${params}`, {
        signal: ac.signal,
      });
      if (!res.ok) {
        console.warn("land API", res.status, await res.text());
        this.emit({ percent: 0, phase: "idle", label: "API error" });
        return null;
      }
      if (mySeq !== this.activeSeq(kind) || this.disposed) return null;

      const text = await this.readBodyWithProgress(res, ac.signal);
      if (mySeq !== this.activeSeq(kind) || this.disposed) return null;

      this.emit({ percent: 37, phase: "parse", label: "Parsing GeoJSON…" });
      const fc = JSON.parse(text) as GeoJsonFeatureCollection;
      const count = fc.count ?? fc.features.length;

      this.emit({
        percent: 40,
        phase: "mesh",
        label: `Meshing ${count} features…`,
        done: 0,
        total: count,
      });

      if (this.worker && this.workerReady) {
        return await this.meshInWorker(
          kind,
          mySeq,
          key,
          lod,
          file,
          fc,
          count,
          bbox,
          opts.heightM
        );
      }

      const { featureCollectionToMesh } = await import("./mesh");
      if (mySeq !== this.activeSeq(kind) || this.disposed) return null;
      const mesh = featureCollectionToMesh(
        fc,
        lod,
        (done, total) => {
          if (mySeq !== this.activeSeq(kind)) return;
          this.emit({
            percent: Math.round(mapMeshPercent(done, total)),
            phase: "mesh",
            label: `Meshing features ${done}/${total}`,
            done,
            total,
          });
        },
        kind === "view" ? { bbox, heightM: opts.heightM } : undefined
      );
      this.emit({ percent: 96, phase: "upload", label: "Uploading mesh…" });
      const result: LandLoadResult = {
        mesh,
        lod,
        file,
        count,
        bbox,
        stats: mesh.stats,
      };
      this.storeResult(kind, key, result);
      this.emit({ percent: 100, phase: "done", label: "Done" });
      return result;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return null;
      }
      console.warn("land load failed", err);
      this.emit({ percent: 0, phase: "idle", label: "Load failed" });
      return null;
    } finally {
      if (kind === "world" && this.inflightWorld === ac) this.inflightWorld = null;
      if (kind === "view" && this.inflightView === ac) this.inflightView = null;
    }
  }

  private async readBodyWithProgress(
    res: Response,
    signal: AbortSignal
  ): Promise<string> {
    const total = Number(res.headers.get("content-length")) || null;
    if (!res.body || typeof res.body.getReader !== "function") {
      return await res.text();
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let lastEmit = 0;

    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        const now = Date.now();
        if (now - lastEmit >= 50) {
          lastEmit = now;
          const pct = Math.round(mapFetchPercent(received, total));
          const label = total
            ? `Downloading ${(received / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB`
            : `Downloading ${(received / 1e6).toFixed(1)} MB`;
          this.emit({ percent: pct, phase: "fetch", label });
        }
      }
    }

    this.emit({
      percent: 35,
      phase: "fetch",
      label: `Downloaded ${(received / 1e6).toFixed(1)} MB`,
    });

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder("utf-8").decode(merged);
  }

  private meshInWorker(
    kind: PendingKind,
    seq: number,
    key: string,
    lod: number,
    file: string,
    fc: GeoJsonFeatureCollection,
    count: number,
    bbox: BBox,
    heightM?: number
  ): Promise<LandLoadResult | null> {
    return new Promise((resolve) => {
      for (const [s, p] of this.pendingMesh) {
        if (p.kind === kind && s < seq) {
          p.resolve(null);
          this.pendingMesh.delete(s);
        }
      }
      this.pendingMesh.set(seq, { kind, key, lod, file, count, bbox, resolve });
      const msg: MeshWorkerRequest = {
        seq,
        lod,
        fc,
        bbox: kind === "view" ? bbox : undefined,
        heightM: kind === "view" ? heightM : undefined,
      };
      this.worker!.postMessage(msg);
    });
  }

  private similarKey(a: string, b: string): boolean {
    const pa = a.split("|");
    const pb = b.split("|");
    if (pa.length < 3 || pb.length < 3) return false;
    if (pa[0] !== pb[0] || pa[2] !== pb[2]) return false;
    const ba = pa[1].split(",").map(Number);
    const bb = pb[1].split(",").map(Number);
    for (let i = 0; i < 4; i++) {
      if (Math.abs(ba[i] - bb[i]) > 2.5) return false;
    }
    return true;
  }
}
