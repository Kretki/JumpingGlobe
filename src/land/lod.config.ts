import lodJson from "../../lod.json";

export type LandLod = number;

export type LodHeightBand = {
  file: string;
  fromHeightM: number;
  orderNum: number;
};

export const WORLD_FILE = lodJson.worldFile;

export const WORLD_BBOX = { west: -180, south: -85, east: 180, north: 85 };

const fileByOrderNum = new Map<number, string>(
  lodJson.bands.map((b) => [b.orderNum, b.file])
);

export const LOD_HEIGHT_BANDS: LodHeightBand[] = lodJson.fromHeightM.flatMap((h) => {
  const file = fileByOrderNum.get(h.orderNum);
  if (!file) return [];
  return [{ file, fromHeightM: h.height, orderNum: h.orderNum }];
});

function bandAtHeight(heightM: number): LodHeightBand | undefined {
  const bands = [...LOD_HEIGHT_BANDS].sort((a, b) => b.fromHeightM - a.fromHeightM);
  for (const band of bands) {
    if (heightM > band.fromHeightM) return band;
  }
  return bands[bands.length - 1];
}

export function lodFileFromHeight(heightM: number): string {
  return bandAtHeight(heightM)?.file ?? WORLD_FILE;
}

export function isWorldLod(heightM: number): boolean {
  return lodFileFromHeight(heightM) === WORLD_FILE;
}

export function meshLodFromFile(file: string): LandLod {
  const byName = LOD_HEIGHT_BANDS.find((b) => b.file === file);
  if (byName) {
    const n = byName.orderNum;
    if (Number.isFinite(n)) return n as LandLod;
  }
  const m = /lod(\d+)/i.exec(file);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n as LandLod;
  }
  return 0;
}

export function lodFromHeight(heightM: number): LandLod {
  return meshLodFromFile(lodFileFromHeight(heightM));
}

export function meshLodFromHeight(heightM: number): LandLod {
  if (heightM > 1_000_000) return 0;
  if (heightM > 400_000) return 1;
  return 2;
}

export function maxSpanFromHeight(heightM: number): number {
  if (heightM > 3_000_000) return 40;
  if (heightM > 1_000_000) return 20;
  if (heightM > 300_000) return 12;
  return 8;
}
