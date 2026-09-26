export type LandLod = 0 | 1 | 2;

export type LodHeightBand = {
  file: string;
  fromHeightM: number;
};

export const WORLD_FILE = "land_lod0.gpkg";

export const WORLD_BBOX = { west: -180, south: -85, east: 180, north: 85 };

export const LOD_HEIGHT_BANDS: LodHeightBand[] = [
  { file: WORLD_FILE, fromHeightM: 4_000_000 },
  { file: "land_lod1.gpkg", fromHeightM: 2_000_000 },
  { file: "land_lod2.gpkg", fromHeightM: 1_000_000 },
];

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
  const m = /lod(\d+)/i.exec(file);
  if (m) {
    const n = Number(m[1]);
    if (n === 0 || n === 1 || n === 2) return n;
  }
  const bands = [...LOD_HEIGHT_BANDS].sort((a, b) => b.fromHeightM - a.fromHeightM);
  const i = bands.findIndex((b) => b.file === file);
  if (i <= 0) return 0;
  if (i === 1) return 1;
  return 2;
}

export function lodFromHeight(heightM: number): LandLod {
  return meshLodFromFile(lodFileFromHeight(heightM));
}
