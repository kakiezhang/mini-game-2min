import type { MeleeKind, MeleeRequest } from "./combat-input.js";
import { normalizeAim } from "./attack-gesture.js";

export type MeleeAction = "punchJab" | "punchRightCross" | "punchCombo" | "punchHook" | "kickSide" | "kickLow" | "kickRoundhouse" | "kickHurricane";
export type MeleeMove = {
  action: MeleeAction; duration: number; hits: readonly number[]; damage: number; range: number;
  kind: MeleeKind;
  recoveryAt: number;
  sweep?: boolean;
};
// Source frames are 1-based, baked clips start at frame 0 at 30 FPS.
// Markers follow hand/foot extension in the supplied Mixamo FBX files.
export const MELEE_MOVES: Record<MeleeAction, MeleeMove> = {
  punchJab: { action: "punchJab", kind: "punch", duration: 31 / 30, recoveryAt: 24 / 30, hits: [17 / 30], damage: 12, range: 74 },
  punchRightCross: { action: "punchRightCross", kind: "punch", duration: 23 / 30, recoveryAt: 18 / 30, hits: [12 / 30], damage: 12, range: 74 },
  punchCombo: { action: "punchCombo", kind: "punch", duration: 66 / 30, recoveryAt: 50 / 30, hits: [19 / 30, 26 / 30, 34 / 30, 41 / 30], damage: 12, range: 74 },
  punchHook: { action: "punchHook", kind: "punch", duration: 65 / 30, recoveryAt: 45 / 30, hits: [34 / 30], damage: 24, range: 80 },
  kickSide: { action: "kickSide", kind: "kick", duration: 38 / 30, recoveryAt: 26 / 30, hits: [15 / 30], damage: 16, range: 94 },
  kickLow: { action: "kickLow", kind: "kick", duration: 36 / 30, recoveryAt: 24 / 30, hits: [14 / 30], damage: 16, range: 90 },
  kickRoundhouse: { action: "kickRoundhouse", kind: "kick", duration: 40 / 30, recoveryAt: 30 / 30, hits: [18 / 30], damage: 16, range: 94 },
  // Four turns sweep nearby targets; each target may be hit once per full action.
  kickHurricane: { action: "kickHurricane", kind: "kick", duration: 71 / 30, recoveryAt: 71 / 30, hits: [0.1, 18 / 30, 36 / 30, 54 / 30], damage: 16, range: 94, sweep: true },
};
export type ActiveMelee = { attackId: number; move: MeleeMove; startedAt: number; aimX: number; aimZ: number; nextHit: number; hitTargets: Set<number> };
export type MeleeHitEvent = { attack: ActiveMelee; attackId: number; markerIndex: number; occurredAt: number };
// Shared by the game and the approved training scene.
export const PUNCH_PLAYBACK_RATES: Partial<Record<MeleeAction, number>> = Object.freeze({
  punchJab: 2.5, punchRightCross: 2, punchCombo: 2,
});

export class MeleeSystem {
  active?: ActiveMelee;
  private punchIndex = 0;
  private kickIndex = 0;
  private attackSequence = 0;
  private queued?: { request: MeleeRequest; expiresAt: number };

  constructor(private readonly punchSelection: {
    cycle: readonly MeleeAction[]; charged: MeleeAction;
  } = { cycle: ["punchJab", "punchRightCross", "punchCombo"], charged: "punchHook" },
  private readonly playbackRates: Partial<Record<MeleeAction, number>> = {}) {
    if (!punchSelection.cycle.length || [...punchSelection.cycle, punchSelection.charged]
      .some(action => MELEE_MOVES[action].kind !== "punch")) throw new Error("Punch selection requires punch actions");
    if (Object.values(playbackRates).some(rate => !Number.isFinite(rate) || rate <= 0)) {
      throw new Error("Melee playback rates must be positive and finite");
    }
  }

  cancel() { this.active = undefined; this.queued = undefined; }
  get locksMovement() { return this.active?.move.kind === "kick"; }
  request(request: MeleeRequest, now: number) {
    // Remember one follow-up until this attack's recovery window, even during
    // the long four-punch combo. Repeated taps replace it rather than pile up.
    this.queued = { request: { ...request }, expiresAt: Math.max(now, this.active ? this.active.startedAt + this.active.move.recoveryAt : now) + 0.4 };
  }
  releaseRecovery(now: number, moving: boolean): MeleeAction | undefined {
    const active = this.active;
    if (!active || now - active.startedAt + 1e-9 < active.move.recoveryAt
      || active.nextHit < active.move.hits.length) return;
    const followingAttack = this.queued && this.queued.expiresAt >= now;
    if (!(moving && active.move.kind === "kick") && !followingAttack) return;
    this.active = undefined;
    return active.move.action;
  }
  advance(now: number) {
    return this.advanceEvents(now).map(event => event.attack);
  }
  advanceEvents(now: number): MeleeHitEvent[] {
    const active = this.active;
    const hits: MeleeHitEvent[] = [];
    if (!active) return hits;
    while (active.nextHit < active.move.hits.length && now - active.startedAt + 1e-9 >= active.move.hits[active.nextHit]) {
      const markerIndex = active.nextHit++;
      hits.push({ attack: active, attackId: active.attackId, markerIndex,
        occurredAt: active.startedAt + active.move.hits[markerIndex] });
    }
    if (now - active.startedAt >= active.move.duration) this.active = undefined;
    return hits;
  }
  startQueued(now: number, aimX: number, aimZ: number, play: (move: MeleeMove) => boolean) {
    if (!this.queued || this.active) return;
    const { request, expiresAt } = this.queued;
    this.queued = undefined;
    if (now > expiresAt) return;
    const punches = this.punchSelection.cycle;
    const kicks: MeleeAction[] = ["kickSide", "kickLow", "kickRoundhouse"];
    const action = request.kind === "punch"
      ? request.charged ? this.punchSelection.charged : punches[this.punchIndex % punches.length]
      : request.charged ? "kickHurricane" : kicks[this.kickIndex % kicks.length];
    const source = MELEE_MOVES[action];
    const rate = this.playbackRates[action] ?? 1;
    // Animation duration, hit markers and recovery must share the same clock.
    const move = rate === 1 ? source : { ...source, duration: source.duration / rate,
      recoveryAt: source.recoveryAt / rate, hits: source.hits.map(time => time / rate) };
    if (!play(move)) return;
    if (!request.charged) {
      if (request.kind === "punch") this.punchIndex += 1;
      else this.kickIndex += 1;
    }
    const aim = normalizeAim({ x: request.aimX ?? aimX, z: request.aimZ ?? aimZ });
    this.active = { attackId: ++this.attackSequence, move, startedAt: now,
      aimX: aim.x, aimZ: aim.z, nextHit: 0, hitTargets: new Set() };
  }
}
