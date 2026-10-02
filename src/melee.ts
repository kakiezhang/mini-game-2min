import type { MeleeKind, MeleeRequest } from "./combat-input.js";

export type MeleeAction = "punchJab" | "punchCombo" | "punchHook" | "kickSide" | "kickLow" | "kickRoundhouse" | "kickHurricane";
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
  punchCombo: { action: "punchCombo", kind: "punch", duration: 66 / 30, recoveryAt: 50 / 30, hits: [19 / 30, 26 / 30, 34 / 30, 41 / 30], damage: 12, range: 74 },
  punchHook: { action: "punchHook", kind: "punch", duration: 65 / 30, recoveryAt: 45 / 30, hits: [34 / 30], damage: 24, range: 80 },
  kickSide: { action: "kickSide", kind: "kick", duration: 38 / 30, recoveryAt: 26 / 30, hits: [15 / 30], damage: 16, range: 94 },
  kickLow: { action: "kickLow", kind: "kick", duration: 36 / 30, recoveryAt: 24 / 30, hits: [14 / 30], damage: 16, range: 90 },
  kickRoundhouse: { action: "kickRoundhouse", kind: "kick", duration: 40 / 30, recoveryAt: 30 / 30, hits: [18 / 30], damage: 16, range: 94 },
  // Four turns sweep nearby targets; each target may be hit once per full action.
  kickHurricane: { action: "kickHurricane", kind: "kick", duration: 71 / 30, recoveryAt: 71 / 30, hits: [0.1, 18 / 30, 36 / 30, 54 / 30], damage: 16, range: 94, sweep: true },
};
export type ActiveMelee = { move: MeleeMove; startedAt: number; aimX: number; aimZ: number; nextHit: number; hitTargets: Set<number> };

export class MeleeSystem {
  active?: ActiveMelee;
  private punchIndex = 0;
  private kickIndex = 0;
  private queued?: { request: MeleeRequest; expiresAt: number };

  cancel() { this.active = undefined; this.queued = undefined; }
  get locksMovement() { return this.active?.move.kind === "kick"; }
  request(request: MeleeRequest, now: number) {
    // Remember one follow-up until this attack's recovery window, even during
    // the long four-punch combo. Repeated taps replace it rather than pile up.
    this.queued = { request, expiresAt: Math.max(now, this.active ? this.active.startedAt + this.active.move.recoveryAt : now) + 0.4 };
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
    const active = this.active;
    const hits: ActiveMelee[] = [];
    if (!active) return hits;
    while (active.nextHit < active.move.hits.length && now - active.startedAt + 1e-9 >= active.move.hits[active.nextHit]) {
      active.nextHit += 1;
      hits.push(active);
    }
    if (now - active.startedAt >= active.move.duration) this.active = undefined;
    return hits;
  }
  startQueued(now: number, aimX: number, aimZ: number, play: (move: MeleeMove) => boolean) {
    if (!this.queued || this.active) return;
    const { request, expiresAt } = this.queued;
    this.queued = undefined;
    if (now > expiresAt) return;
    const punches: MeleeAction[] = ["punchJab", "punchCombo"];
    const kicks: MeleeAction[] = ["kickSide", "kickLow", "kickRoundhouse"];
    const action = request.kind === "punch"
      ? request.charged ? "punchHook" : punches[this.punchIndex % punches.length]
      : request.charged ? "kickHurricane" : kicks[this.kickIndex % kicks.length];
    const move = MELEE_MOVES[action];
    if (!play(move)) return;
    if (!request.charged) {
      if (request.kind === "punch") this.punchIndex += 1;
      else this.kickIndex += 1;
    }
    this.active = { move, startedAt: now, aimX, aimZ, nextHit: 0, hitTargets: new Set() };
  }
}
