/** Move plate-tagged land meshes to their position at a given age (CPU, per vertex). */

import type { LandMesh, PlateGroup } from "../land/mesh";
import { IDENTITY, quatRotate, type Quat, type RotationTree } from "./rotation";

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/**
 * Present-day mesh in rotation-friendly form. GPlates rotates lon/lat as points
 * on a sphere, so each vertex keeps the unit vector of its geodetic lon/lat plus
 * its height above the ellipsoid; positions are rebuilt on the ellipsoid after
 * rotating, so land never floats above or sinks below the surface when it moves
 * to another latitude.
 */
export type PlateMesh = {
  unit: Float32Array;
  height: Float32Array;
  groupIdx: Uint16Array;
  groups: PlateGroup[];
  indices: Uint32Array;
  positions: Float32Array;
  normals: Float32Array;
  /** Any group carries a real plate id (false for untagged LOD files). */
  tagged: boolean;
};

export function preparePlateMesh(mesh: LandMesh): PlateMesh {
  const n = mesh.positions.length / 3;
  const unit = new Float32Array(n * 3);
  const height = new Float32Array(n);
  const P = mesh.positions;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3];
    const y = P[i * 3 + 1];
    const z = P[i * 3 + 2];
    const p = Math.hypot(x, y);
    // Bowring-style fixed point; land sits within metres of the ellipsoid.
    let lat = Math.atan2(z, p * (1 - WGS84_E2));
    for (let k = 0; k < 3; k++) {
      const s = Math.sin(lat);
      const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
      lat = Math.atan2(z + WGS84_E2 * N * s, p);
    }
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    height[i] = Math.abs(cosLat) > 1e-9 ? p / cosLat - N : Math.abs(z) - N * (1 - WGS84_E2);
    const lon = Math.atan2(y, x);
    unit[i * 3] = cosLat * Math.cos(lon);
    unit[i * 3 + 1] = cosLat * Math.sin(lon);
    unit[i * 3 + 2] = sinLat;
  }
  return {
    unit,
    height,
    groupIdx: mesh.groupIdx,
    groups: mesh.groups,
    indices: mesh.indices,
    positions: new Float32Array(mesh.positions),
    normals: new Float32Array(mesh.normals),
    tagged: mesh.groups.some((g) => g.plateId !== 0),
  };
}

export type ReconstructStats = { groups: number; shown: number; noRotation: number; notYetFormed: number };

/**
 * Rewrite `pm.positions` / `pm.normals` for `age` (Ma). Groups outside their
 * lifetime, or whose plate chain has no poles at that age, collapse to the origin
 * (zero-area triangles, i.e. not drawn).
 */
export function reconstruct(pm: PlateMesh, tree: RotationTree | null, age: number): ReconstructStats {
  const stats: ReconstructStats = { groups: pm.groups.length, shown: 0, noRotation: 0, notYetFormed: 0 };
  const quats: (Quat | null)[] = pm.groups.map((g) => {
    if (age > g.fromAge || age < g.toAge) {
      stats.notYetFormed++;
      return null;
    }
    const q = !tree || age <= 0 || g.plateId === 0 ? IDENTITY : tree.total(g.plateId, age);
    if (!q) stats.noRotation++;
    else stats.shown++;
    return q;
  });

  const { unit: U, height: H, groupIdx: G, positions: P, normals: Nrm } = pm;
  const v = [0, 0, 0];
  const n = H.length;
  for (let i = 0; i < n; i++) {
    const q = quats[G[i]];
    const o = i * 3;
    if (!q) {
      P[o] = P[o + 1] = P[o + 2] = 0;
      continue;
    }
    quatRotate(q, U[o], U[o + 1], U[o + 2], v);
    const sinLat = v[2];
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const h = H[i];
    P[o] = (N + h) * v[0];
    P[o + 1] = (N + h) * v[1];
    P[o + 2] = (N * (1 - WGS84_E2) + h) * v[2];
    // Ellipsoid normal at geodetic (lon, lat) is exactly the rotated unit vector.
    Nrm[o] = v[0];
    Nrm[o + 1] = v[1];
    Nrm[o + 2] = v[2];
  }
  return stats;
}
