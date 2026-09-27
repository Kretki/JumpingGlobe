import lodJson from "../../lod.json";

export type LandLod = number;

export type LodHeightBand = {
  file: string;
  fromHeightM: number;
  orderNum: number;
};

export const WORLD_FILE = lodJson.worldFile;

export const WORLD_BBOX = { west: -180, south: -85, east: 180, north: 85 };

const bandsSorted = [...lodJson.bands].sort((a, b) => a.orderNum - b.orderNum);

const fileByOrderNum = new Map<number, string>(
  lodJson.bands.map((b) => [b.orderNum, b.file])
);

function bandByOrderNum(n: number) {
  const exact = lodJson.bands.find((b) => b.orderNum === n);
  if (exact) return exact;
  if (bandsSorted.length === 0) {
    return { file: WORLD_FILE, orderNum: 0, maxEdgeM: 25000, maxBoundaryEdgeM: 25000 };
  }
  if (n <= bandsSorted[0].orderNum) return bandsSorted[0];
  return bandsSorted[bandsSorted.length - 1];
}

function rowAtHeight(heightM: number) {
  const rows = [...lodJson.fromHeightM].sort((a, b) => b.height - a.height);
  if (rows.length === 0) {
    return {
      orderNum: 0,
      height: 0,
      maxSpanDeg: 40,
      minAreaDeg2: 0,
      featureLimit: 4000,
    };
  }
  for (const r of rows) {
    if (heightM > r.height) return r;
  }
  return rows[rows.length - 1];
}

export const LOD_HEIGHT_BANDS: LodHeightBand[] = lodJson.fromHeightM.flatMap((h) => {
  const file = fileByOrderNum.get(h.orderNum);
  if (!file) return [];
  return [{ file, fromHeightM: h.height, orderNum: h.orderNum }];
});

function bandAtHeight(heightM: number): LodHeightBand | undefined {
  const row = rowAtHeight(heightM);
  const file = fileByOrderNum.get(row.orderNum) ?? WORLD_FILE;
  return { file, fromHeightM: row.height, orderNum: row.orderNum };
}

export function lodFileFromHeight(heightM: number): string {
  return bandAtHeight(heightM)?.file ?? WORLD_FILE;
}

export function isWorldLod(heightM: number): boolean {
  return lodFileFromHeight(heightM) === WORLD_FILE;
}

export function meshLodFromFile(file: string): LandLod {
  const byName = lodJson.bands.find((b) => b.file === file);
  if (byName && Number.isFinite(byName.orderNum)) return byName.orderNum;
  const m = /lod(\d+)/i.exec(file);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return bandsSorted[0]?.orderNum ?? 0;
}

export function lodFromHeight(heightM: number): LandLod {
  return rowAtHeight(heightM).orderNum;
}

export function meshLodFromHeight(heightM: number): LandLod {
  return rowAtHeight(heightM).orderNum;
}

export function maxSpanFromHeight(heightM: number): number {
  return rowAtHeight(heightM).maxSpanDeg;
}

export function minAreaFromHeight(heightM: number): number {
  return rowAtHeight(heightM).minAreaDeg2;
}

export function featureLimitFromHeight(heightM: number): number {
  return rowAtHeight(heightM).featureLimit;
}

export function maxEdgeMFromOrderNum(n: number): number {
  return bandByOrderNum(n).maxEdgeM;
}

export function maxBoundaryEdgeMFromOrderNum(n: number): number {
  return bandByOrderNum(n).maxBoundaryEdgeM;
}
