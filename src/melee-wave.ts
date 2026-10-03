import { AttackShape, JAB_WAVE, sweptCircleIntersectsBand, type AttackWorld, type GroundPoint, type WaveSpec } from "./attack-shape.js";
import type { MeleeHitEvent } from "./melee.js";

export type WaveTarget = { id: number; previous: GroundPoint; position: GroundPoint; radius: number; alive: boolean; spawning?: boolean };
export type WaveInstance = {
  id: string; attackId: number; markerIndex: number; bornAt: number; age: number;
  shape: AttackShape; spec: Readonly<WaveSpec>; hitTargets: Set<number>; triangles: number[];
};
export type WaveHit = { waveId: string; targetId: number; damage: number };

export class MeleeWaveSystem {
  readonly waves: WaveInstance[] = [];
  private readonly seen = new Map<number, Set<number>>();
  private highestAttack = 0;
  private readonly collisionBand: number[] = [];

  constructor(private readonly world: AttackWorld) {}

  clear() { this.waves.length = 0; this.seen.clear(); this.highestAttack = 0; }

  spawn(event: MeleeHitEvent, origin: GroundPoint, spec: Readonly<WaveSpec> = JAB_WAVE) {
    // Bounded replay protection; the melee clock emits monotonic attack IDs.
    if (event.attackId < this.highestAttack - 128) return false;
    const markers = this.seen.get(event.attackId) ?? new Set<number>();
    if (markers.has(event.markerIndex)) return false;
    markers.add(event.markerIndex); this.seen.set(event.attackId, markers);
    this.highestAttack = Math.max(this.highestAttack, event.attackId);
    for (const id of this.seen.keys()) if (id < this.highestAttack - 128) this.seen.delete(id);
    const snapshot = Object.freeze({ ...spec });
    const shape = new AttackShape(origin, { x: event.attack.aimX, z: event.attack.aimZ }, snapshot, this.world);
    this.waves.push({ id: `${event.attackId}:${event.markerIndex}`, attackId: event.attackId, markerIndex: event.markerIndex,
      bornAt: event.occurredAt, age: 0, shape, spec: snapshot, hitTargets: new Set(), triangles: [] });
    return true;
  }

  advance(from: number, to: number, targets: readonly WaveTarget[]): WaveHit[] {
    if (to <= from) return [];
    const hits: WaveHit[] = [];
    const frameDuration = to - from;
    const maxTargetSpeed = Math.max(0, ...targets.map(target => Math.hypot(
      target.position.x - target.previous.x, target.position.z - target.previous.z) / frameDuration));
    const sample = (target: WaveTarget, time: number): GroundPoint => {
      const fraction = Math.max(0, Math.min(1, (time - from) / frameDuration));
      return { x: target.previous.x + (target.position.x - target.previous.x) * fraction,
        z: target.previous.z + (target.position.z - target.previous.z) * fraction };
    };
    for (const wave of this.waves) {
      const end = wave.bornAt + wave.spec.range / wave.spec.speed;
      const start = Math.max(from, wave.bornAt), finish = Math.min(to, end);
      if (finish > start) {
        const steps = Math.max(1, Math.ceil((finish - start) * (wave.spec.speed + maxTargetSpeed) / 4));
        for (let step = 0; step < steps; step++) {
          const t0 = start + (finish - start) * step / steps;
          const t1 = start + (finish - start) * (step + 1) / steps;
          const inner = Math.max(0, (t0 - wave.bornAt) * wave.spec.speed - wave.spec.thickness);
          const outer = Math.min(wave.spec.range, (t1 - wave.bornAt) * wave.spec.speed);
          wave.shape.updateOcclusion(outer);
          wave.shape.writeBand(inner, outer, this.collisionBand);
          for (const target of targets) {
            if (!target.alive || target.spawning || wave.hitTargets.has(target.id)) continue;
            if (!sweptCircleIntersectsBand(sample(target, t0), sample(target, t1), target.radius, this.collisionBand)) continue;
            wave.hitTargets.add(target.id);
            hits.push({ waveId: wave.id, targetId: target.id, damage: wave.spec.damage });
          }
        }
      }
      wave.age = Math.max(0, to - wave.bornAt);
      const radius = Math.min(wave.spec.range, wave.age * wave.spec.speed);
      wave.shape.writeBand(Math.max(0, radius - wave.spec.thickness), radius, wave.triangles);
    }
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const wave = this.waves[i];
      if (to >= wave.bornAt + wave.spec.range / wave.spec.speed + wave.spec.fade) this.waves.splice(i, 1);
    }
    return hits;
  }
}
