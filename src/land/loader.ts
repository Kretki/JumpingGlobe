/** Fetch land polygons from the GPKG API (LOD + bbox, EPSG:4326) and mesh off-thread. */

import type { GeoJsonFeatureCollection, LandMesh, MeshStats } from "./mesh";
import type { MeshWorkerRequest, MeshWorkerResponse } from "./meshWorker";

export type BBox = { west: number; south: number; east: number; north: number };

export type LandLoadResult = {
  mesh: LandMesh;
  lod: number;
  count: number;
  bbox: BBox;
  stats?: MeshStats;
};

/** Overall load progress for UI (0–100). */
export type LandLoadProgress = {
  percent: number;
  phase: "idle" | "fetch" | "parse" | "mesh" | "upload" | "done";
  label: string;
  /** Optional sub-counts for mesh phase */
  done?: number;
  total?: number;
};

export type LandProgressFn = (p: LandLoadProgress) => void;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Choose LOD from camera height (meters above ellipsoid). */
export function lodFromHeight(heightM: number): 0 | 1 | 2 {
  if (heightM > 4_000_000) return 0;
  if (heightM > 800_000) return 1;
  return 2;
}

/** Drop tiny islands when zoomed out (envelope area deg²). */
export function minAreaFromHeight(heightM: number): number {
  if (heightM > 8_000_000) return 0.5;
  if (heightM > 3_000_000) return 0.05;
  if (heightM > 1_000_000) return 0.005;
  if (heightM > 300_000) return 0.0005;
  return 0;
}

export function featureLimitFromHeight(heightM: number): number {
  if (heightM > 8_000_000) return 8_000;
  if (heightM > 3_000_000) return 15_000;
  if (heightM > 1_000_000) return 25_000;
  return 40_000;
}

/**
 * Approximate visible lon/lat bbox from camera look direction + height.
 * Pads so orbit/pan does not constantly reload.
 */
export function viewBBox(
  lonDeg: number,
  latDeg: number,
  heightM: number,
  padScale = 1.35
): BBox {
  const R = 6_371_000;
  const ang = Math.acos(clamp(R / (R + Math.max(heightM, 1)), -1, 1));
  let halfLon = ((ang * 180) / Math.PI) * padScale;
  let halfLat = halfLon * padScale;
  const cosLat = Math.max(0.15, Math.cos((latDeg * Math.PI) / 180));
  halfLon = Math.min(180, halfLon / cosLat);
  halfLat = Math.min(90, halfLat);

  if (heightM > 6_000_000) {
    return { west: -180, south: -85, east: 180, north: 85 };
  }

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

  const span = west <= east ? east - west : 360 - (west - east);
  if (span > 300) {
    return { west: -180, south, east: 180, north };
  }

  return { west, south, east, north };
}

function bboxKey(b: BBox, lod: number, minArea: number): string {
  const q = (n: number) => n.toFixed(2);
  return `${lod}|${q(b.west)},${q(b.south)},${q(b.east)},${q(b.north)}|${minArea.toFixed(4)}`;
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

  get size() {
    return this.map.size;
  }
}

/** Fetch 0–35%, parse 35–40%, mesh 40–95%, upload/done 95–100%. */
function mapFetchPercent(bytes: number, total: number | null): number {
  if (total && total > 0) return clamp((bytes / total) * 35, 0, 35);
  // Unknown length: asymptotic approach toward 30%
  return clamp(30 * (1 - Math.exp(-bytes / 2e6)), 0, 30);
}

function mapMeshPercent(done: number, total: number): number {
  const t = total > 0 ? done / total : 1;
  return 40 + t * 55; // 40 → 95
}

export class LandLoader {
  private cache = new LruCache<LandLoadResult>(12);
  private inflightFetch: AbortController | null = null;
  private lastKey = "";
  private baseUrl: string;
  private lastGood: LandLoadResult | null = null;
  private worker: Worker | null = null;
  private seq = 0;
  private pendingMesh = new Map<
    number,
    {
      key: string;
      lod: number;
      count: number;
      bbox: BBox;
      resolve: (r: LandLoadResult | null) => void;
    }
  >();
  private workerReady = false;
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

  private onWorkerMessage(data: MeshWorkerResponse) {
    if (data.type === "progress") {
      if (data.seq !== this.seq) return;
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

    if (data.seq !== this.seq) {
      pending.resolve(this.lastGood);
      return;
    }

    if (!data.ok) {
      console.warn("land mesh failed", data.error);
      this.emit({ percent: 0, phase: "idle", label: "Mesh failed" });
      pending.resolve(this.lastGood);
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
      count: pending.count,
      bbox: pending.bbox,
      stats: data.stats,
    };
    this.cache.set(pending.key, result);
    this.lastKey = pending.key;
    this.lastGood = result;
    this.emit({ percent: 100, phase: "done", label: "Done" });
    pending.resolve(result);
  }

  getLastGood(): LandLoadResult | null {
    return this.lastGood;
  }

  async loadForView(
    lonDeg: number,
    latDeg: number,
    heightM: number
  ): Promise<LandLoadResult | null> {
    const lod = lodFromHeight(heightM);
    const bbox = viewBBox(lonDeg, latDeg, heightM);
    const minArea = minAreaFromHeight(heightM);
    const limit = featureLimitFromHeight(heightM);
    const key = bboxKey(bbox, lod, minArea);

    const cached = this.cache.get(key);
    if (cached) {
      this.lastKey = key;
      this.lastGood = cached;
      this.emit({ percent: 100, phase: "done", label: "Cached" });
      return cached;
    }

    if (this.lastKey && this.similarKey(this.lastKey, key)) {
      const prev = this.cache.get(this.lastKey);
      if (prev) {
        this.lastGood = prev;
        this.emit({ percent: 100, phase: "done", label: "Cached" });
        return prev;
      }
    }

    if (this.inflightFetch) this.inflightFetch.abort();
    const ac = new AbortController();
    this.inflightFetch = ac;

    const mySeq = ++this.seq;

    const params = new URLSearchParams({
      lod: String(lod),
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
        return this.lastGood;
      }
      if (mySeq !== this.seq) return this.lastGood;

      const text = await this.readBodyWithProgress(res, ac.signal);
      if (mySeq !== this.seq) return this.lastGood;

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
        return await this.meshInWorker(mySeq, key, lod, fc, count, bbox);
      }

      const { featureCollectionToMesh } = await import("./mesh");
      if (mySeq !== this.seq) return this.lastGood;
      const mesh = featureCollectionToMesh(fc, lod, (done, total) => {
        if (mySeq !== this.seq) return;
        this.emit({
          percent: Math.round(mapMeshPercent(done, total)),
          phase: "mesh",
          label: `Meshing features ${done}/${total}`,
          done,
          total,
        });
      });
      this.emit({ percent: 96, phase: "upload", label: "Uploading mesh…" });
      const result: LandLoadResult = {
        mesh,
        lod,
        count,
        bbox,
        stats: mesh.stats,
      };
      this.cache.set(key, result);
      this.lastKey = key;
      this.lastGood = result;
      this.emit({ percent: 100, phase: "done", label: "Done" });
      return result;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return this.lastGood;
      }
      console.warn("land load failed", err);
      this.emit({ percent: 0, phase: "idle", label: "Load failed" });
      return this.lastGood;
    } finally {
      if (this.inflightFetch === ac) this.inflightFetch = null;
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
    seq: number,
    key: string,
    lod: 0 | 1 | 2,
    fc: GeoJsonFeatureCollection,
    count: number,
    bbox: BBox
  ): Promise<LandLoadResult | null> {
    return new Promise((resolve) => {
      for (const [s, p] of this.pendingMesh) {
        if (s < seq) {
          p.resolve(this.lastGood);
          this.pendingMesh.delete(s);
        }
      }
      this.pendingMesh.set(seq, { key, lod, count, bbox, resolve });
      const msg: MeshWorkerRequest = { seq, lod, fc };
      this.worker!.postMessage(msg);
    });
  }

  private similarKey(a: string, b: string): boolean {
    const pa = a.split("|");
    const pb = b.split("|");
    if (pa[0] !== pb[0] || pa[2] !== pb[2]) return false;
    const ba = pa[1].split(",").map(Number);
    const bb = pb[1].split(",").map(Number);
    for (let i = 0; i < 4; i++) {
      if (Math.abs(ba[i] - bb[i]) > 2.5) return false;
    }
    return true;
  }
}
