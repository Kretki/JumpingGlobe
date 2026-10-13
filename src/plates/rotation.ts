/**
 * GPlates-style plate reconstruction from a .rot model (Merdith et al. 2021).
 *
 * Each row of the rotation file is a *total* reconstruction pole: the finite
 * rotation of a moving plate relative to a fixed plate that takes present-day
 * geometry to its position at that age. Rows of one moving plate with the same
 * fixed plate form an interpolation sequence (quaternion slerp between poles);
 * the fixed plate may change between sequences (crossovers). The rotation of a
 * plate relative to the anchor (000, spin axis) is the chain
 *   R(P→0, t) = R(F→0, t) · R(P→F, t).
 */

/** [age Ma, pole lat°, pole lon°, angle°, fixed plate id] */
export type RotationPole = [number, number, number, number, number];

export type RotationModel = {
  maxAge: number;
  anchorPlate: number;
  continentsFile: string | null;
  plates: Record<string, RotationPole[]>;
};

/** Unit quaternion [w, x, y, z]. */
export type Quat = [number, number, number, number];

export const IDENTITY: Quat = [1, 0, 0, 0];

const D2R = Math.PI / 180;

export function quatFromPole(latDeg: number, lonDeg: number, angleDeg: number): Quat {
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  const half = (angleDeg * D2R) / 2;
  const s = Math.sin(half);
  const cl = Math.cos(lat);
  return [Math.cos(half), s * cl * Math.cos(lon), s * cl * Math.sin(lon), s * Math.sin(lat)];
}

export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export function quatSlerp(a: Quat, b0: Quat, t: number): Quat {
  let b = b0;
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (dot < 0) {
    b = [-b[0], -b[1], -b[2], -b[3]];
    dot = -dot;
  }
  let k0: number;
  let k1: number;
  if (dot > 0.9999995) {
    k0 = 1 - t;
    k1 = t;
  } else {
    const th = Math.acos(Math.min(1, dot));
    const s = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / s;
    k1 = Math.sin(t * th) / s;
  }
  const q: Quat = [k0 * a[0] + k1 * b[0], k0 * a[1] + k1 * b[1], k0 * a[2] + k1 * b[2], k0 * a[3] + k1 * b[3]];
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotate unit vector v by q (writes into out). */
export function quatRotate(q: Quat, x: number, y: number, z: number, out: number[] | Float32Array, o = 0) {
  const [w, qx, qy, qz] = q;
  // t = 2 * cross(q.xyz, v); v' = v + w t + cross(q.xyz, t)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[o] = x + w * tx + (qy * tz - qz * ty);
  out[o + 1] = y + w * ty + (qz * tx - qx * tz);
  out[o + 2] = z + w * tz + (qx * ty - qy * tx);
}

type Sequence = { fixed: number; ages: number[]; quats: Quat[] };

export class RotationTree {
  readonly maxAge: number;
  private seqs = new Map<number, Sequence[]>();
  private memoAge = NaN;
  private memo = new Map<number, Quat | null>();

  constructor(model: RotationModel) {
    this.maxAge = model.maxAge;
    for (const [id, poles] of Object.entries(model.plates)) {
      const list: Sequence[] = [];
      let cur: Sequence | null = null;
      for (const [age, lat, lon, angle, fixed] of poles) {
        if (!cur || cur.fixed !== fixed) {
          cur = { fixed, ages: [], quats: [] };
          list.push(cur);
        }
        cur.ages.push(age);
        cur.quats.push(quatFromPole(lat, lon, angle));
      }
      this.seqs.set(Number(id), list);
    }
  }

  get plateCount(): number {
    return this.seqs.size;
  }

  /** Rotation of `plate` relative to its fixed plate at `age`, or null if undefined then. */
  relative(plate: number, age: number): { fixed: number; q: Quat } | null {
    const list = this.seqs.get(plate);
    if (!list) return null;
    for (const s of list) {
      const n = s.ages.length;
      if (age < s.ages[0] || age > s.ages[n - 1]) continue;
      if (n === 1) return { fixed: s.fixed, q: s.quats[0] };
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (s.ages[mid] <= age) lo = mid;
        else hi = mid;
      }
      const a0 = s.ages[lo];
      const a1 = s.ages[hi];
      const t = a1 > a0 ? (age - a0) / (a1 - a0) : 0;
      return { fixed: s.fixed, q: quatSlerp(s.quats[lo], s.quats[hi], t) };
    }
    return null;
  }

  /**
   * Rotation of `plate` relative to the anchor (spin axis) at `age`, or null when
   * the model has no poles for some link of its plate chain at that age. GPlates
   * would fall back to identity there, which snaps the plate to its present-day
   * position; callers hide such geometry instead.
   */
  total(plate: number, age: number): Quat | null {
    if (age !== this.memoAge) {
      this.memoAge = age;
      this.memo.clear();
    }
    return this.totalMemo(plate, age, 0);
  }

  private totalMemo(plate: number, age: number, depth: number): Quat | null {
    if (plate === 0 || age <= 0) return IDENTITY;
    const hit = this.memo.get(plate);
    if (hit !== undefined) return hit;
    let q: Quat | null = null;
    const rel = depth < 64 ? this.relative(plate, age) : null;
    if (rel) {
      if (rel.fixed === plate || rel.fixed === 0) q = rel.q;
      else {
        const parent = this.totalMemo(rel.fixed, age, depth + 1);
        q = parent ? quatMul(parent, rel.q) : null;
      }
    }
    this.memo.set(plate, q);
    return q;
  }
}
