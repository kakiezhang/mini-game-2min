import type { NavigationWorld } from "./navigation.js";
import { normalizeAim, type AttackDirection } from "./attack-gesture.js";

export type GroundPoint = { x: number; z: number };
export type AttackWorld = Pick<NavigationWorld, "getObstacles" | "raycastObstacleDistance">;
export type WaveSpec = { range: number; halfAngle: number; speed: number; thickness: number; damage: number; fade: number };
export const JAB_WAVE: Readonly<WaveSpec> = Object.freeze({ range: 112, halfAngle: Math.PI / 3,
  speed: 400, thickness: 16, damage: 12, fade: 0.08 });
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** The same clipped triangles are consumed by collision, preview, and rendering. */
export class AttackShape {
  readonly angles: number[];
  private readonly limits: number[];
  private readonly stopped: number[];
  readonly direction: AttackDirection;
  readonly origin: GroundPoint;

  constructor(origin: GroundPoint, direction: AttackDirection, readonly spec: Readonly<WaveSpec>, private readonly world: AttackWorld) {
    this.origin = { ...origin };
    this.direction = normalizeAim(direction);
    const heading = Math.atan2(this.direction.x, this.direction.z);
    const offsets = new Set(Array.from({ length: 33 }, (_, i) => -spec.halfAngle + i * spec.halfAngle / 16));
    // Include inactive door corners too: angle indices stay stable when it opens/closes.
    for (const obstacle of world.getObstacles()) {
      const dxToBox = Math.max(0, Math.abs(obstacle.x - origin.x) - obstacle.width / 2);
      const dzToBox = Math.max(0, Math.abs(obstacle.z - origin.z) - obstacle.depth / 2);
      if (dxToBox * dxToBox + dzToBox * dzToBox > spec.range * spec.range) continue;
      for (const dx of [-obstacle.width / 2, obstacle.width / 2]) for (const dz of [-obstacle.depth / 2, obstacle.depth / 2]) {
        const angle = wrap(Math.atan2(obstacle.x + dx - origin.x, obstacle.z + dz - origin.z) - heading);
        for (const epsilon of [-1e-5, 0, 1e-5]) {
          const sample = angle + epsilon;
          if (sample > -spec.halfAngle && sample < spec.halfAngle) offsets.add(sample);
        }
      }
    }
    this.angles = [...offsets].sort((a, b) => a - b).map(offset => heading + offset);
    this.limits = this.angles.map(() => spec.range);
    this.stopped = this.angles.map(() => Infinity);
    this.updateOcclusion();
  }

  updateOcclusion(front?: number) {
    this.angles.forEach((angle, i) => {
      const limit = this.world.raycastObstacleDistance(this.origin.x, this.origin.z, Math.sin(angle), Math.cos(angle), this.spec.range);
      // Only a wave that has actually reached a closed surface loses that segment.
      if (front !== undefined && limit < this.spec.range && front >= limit) this.stopped[i] = Math.min(this.stopped[i], limit);
      this.limits[i] = Math.min(limit, this.stopped[i]);
    });
  }

  writeBand(inner: number, outer: number, output: number[]) {
    output.length = 0;
    for (let i = 0; i < this.angles.length - 1; i++) {
      const a = this.angles[i], b = this.angles[i + 1];
      const ai = Math.min(inner, this.limits[i]), ao = Math.min(outer, this.limits[i]);
      const bi = Math.min(inner, this.limits[i + 1]), bo = Math.min(outer, this.limits[i + 1]);
      if (ao <= ai && bo <= bi) continue;
      const x0 = this.origin.x + Math.sin(a) * ai, z0 = this.origin.z + Math.cos(a) * ai;
      const x1 = this.origin.x + Math.sin(a) * ao, z1 = this.origin.z + Math.cos(a) * ao;
      const x2 = this.origin.x + Math.sin(b) * bo, z2 = this.origin.z + Math.cos(b) * bo;
      const x3 = this.origin.x + Math.sin(b) * bi, z3 = this.origin.z + Math.cos(b) * bi;
      output.push(x0, z0, x1, z1, x2, z2, x0, z0, x2, z2, x3, z3);
    }
    return output;
  }
}

const cross = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx;
const segmentDistanceSquared = (x: number, z: number, ax: number, az: number, bx: number, bz: number) => {
  const dx = bx - ax, dz = bz - az, length = dx * dx + dz * dz;
  const t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length)) : 0;
  return (x - ax - t * dx) ** 2 + (z - az - t * dz) ** 2;
};
function segmentsIntersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number) {
  const denominator = cross(bx - ax, bz - az, dx - cx, dz - cz);
  if (Math.abs(denominator) < 1e-10) return false;
  const t = cross(cx - ax, cz - az, dx - cx, dz - cz) / denominator;
  const u = cross(cx - ax, cz - az, bx - ax, bz - az) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Swept target circle vs the wave's swept band, used with <=4-unit relative substeps. */
export function sweptCircleIntersectsBand(from: GroundPoint, to: GroundPoint, radius: number, triangles: readonly number[]) {
  const radiusSquared = radius * radius;
  for (let i = 0; i < triangles.length; i += 6) {
    const ax = triangles[i], az = triangles[i + 1], bx = triangles[i + 2], bz = triangles[i + 3], cx = triangles[i + 4], cz = triangles[i + 5];
    const area = cross(bx - ax, bz - az, cx - ax, cz - az);
    if (Math.abs(area) < 1e-10) continue;
    for (const p of [from, to]) {
      const a = cross(bx - ax, bz - az, p.x - ax, p.z - az);
      const b = cross(cx - bx, cz - bz, p.x - bx, p.z - bz);
      const c = cross(ax - cx, az - cz, p.x - cx, p.z - cz);
      if ((a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0)) return true;
    }
    for (const [x1, z1, x2, z2] of [[ax, az, bx, bz], [bx, bz, cx, cz], [cx, cz, ax, az]]) {
      if (segmentsIntersect(from.x, from.z, to.x, to.z, x1, z1, x2, z2)
        || segmentDistanceSquared(from.x, from.z, x1, z1, x2, z2) <= radiusSquared
        || segmentDistanceSquared(to.x, to.z, x1, z1, x2, z2) <= radiusSquared
        || segmentDistanceSquared(x1, z1, from.x, from.z, to.x, to.z) <= radiusSquared
        || segmentDistanceSquared(x2, z2, from.x, from.z, to.x, to.z) <= radiusSquared) return true;
    }
  }
  return false;
}
