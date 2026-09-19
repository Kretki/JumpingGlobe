/** Fetch land polygons from the GPKG API (LOD + bbox, EPSG:4326). */

import type { GeoJsonFeatureCollection, LandMesh } from "./mesh";
import { featureCollectionToMesh } from "./mesh";

export type BBox = { west: number; south: number; east: number; north: number };

export type LandLoadResult = {
  mesh: LandMesh;
  lod: number;
  count: number;
  bbox: BBox;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Choose LOD from camera height (meters above ellipsoid). */
export function lodFromHeight(heightM: number): number {
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
  // Angular half-extent roughly from altitude (sphere approx)
  const R = 6_371_000;
  const ang = Math.acos(clamp(R / (R + Math.max(heightM, 1)), -1, 1));
  let halfLon = ((ang * 180) / Math.PI) * padScale;
  let halfLat = halfLon * padScale;
  // Widen longitude near poles
  const cosLat = Math.max(0.15, Math.cos((latDeg * Math.PI) / 180));
  halfLon = Math.min(180, halfLon / cosLat);
  halfLat = Math.min(90, halfLat);

  // When very high, show most of the globe
  if (heightM > 6_000_000) {
    return { west: -180, south: -85, east: 180, north: 85 };
  }

  let south = clamp(latDeg - halfLat, -85, 85);
  let north = clamp(latDeg + halfLat, -85, 85);
  let west = lonDeg - halfLon;
  let east = lonDeg + halfLon;

  // Normalize longitudes to [-180, 180]; allow west > east for antimeridian
  const norm = (L: number) => {
    let x = ((((L + 180) % 360) + 360) % 360) - 180;
    return x;
  };
  west = norm(west);
  east = norm(east);

  // If span covers nearly full globe, just request full range
  const span =
    west <= east ? east - west : 360 - (west - east);
  if (span > 300) {
    return { west: -180, south, east: 180, north };
  }

  return { west, south, east, north };
}

function bboxKey(b: BBox, lod: number, minArea: number): string {
  const q = (n: number) => n.toFixed(2);
  return `${lod}|${q(b.west)},${q(b.south)},${q(b.east)},${q(b.north)}|${minArea.toFixed(4)}`;
}

export class LandLoader {
  private cache = new Map<string, LandLoadResult>();
  private inflight: AbortController | null = null;
  private lastKey = "";
  private baseUrl: string;

  constructor(baseUrl = "/api") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /** Debounced load for current view; returns null if skipped/aborted. */
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

    if (key === this.lastKey && this.cache.has(key)) {
      return this.cache.get(key)!;
    }
    if (this.cache.has(key)) {
      this.lastKey = key;
      return this.cache.get(key)!;
    }

    // Quantize: skip if only tiny camera move from last successful key
    if (this.lastKey && this.similarKey(this.lastKey, key)) {
      return this.cache.get(this.lastKey) ?? null;
    }

    if (this.inflight) this.inflight.abort();
    const ac = new AbortController();
    this.inflight = ac;

    const params = new URLSearchParams({
      lod: String(lod),
      bbox: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
      limit: String(limit),
      min_area: String(minArea),
    });

    try {
      const res = await fetch(`${this.baseUrl}/land?${params}`, {
        signal: ac.signal,
      });
      if (!res.ok) {
        console.warn("land API", res.status, await res.text());
        return null;
      }
      const fc = (await res.json()) as GeoJsonFeatureCollection;
      const maxStep = lod === 0 ? 4 : lod === 1 ? 2 : 1;
      const mesh = featureCollectionToMesh(fc, maxStep);
      const result: LandLoadResult = {
        mesh,
        lod,
        count: fc.count ?? fc.features.length,
        bbox,
      };
      this.cache.set(key, result);
      this.lastKey = key;
      // Bound memory
      if (this.cache.size > 12) {
        const first = this.cache.keys().next().value as string;
        this.cache.delete(first);
      }
      return result;
    } catch (err) {
      if ((err as Error).name === "AbortError") return null;
      console.warn("land load failed", err);
      return null;
    } finally {
      if (this.inflight === ac) this.inflight = null;
    }
  }

  private similarKey(a: string, b: string): boolean {
    // same lod + minArea and bbox corners within ~2°
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
