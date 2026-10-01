import type { MeleeRequest } from "./combat-input.js";

export type MeleeAction = "punchJab" | "punchCombo" | "punchHook" | "kickSide" | "kickLow" | "kickRoundhouse" | "kickHurricane";
export type MeleeMove = {
  action: MeleeAction; duration: number; hits: readonly number[]; damage: number; range: number;
  sweep?: boolean;
};
// Source frames are 1-based, baked clips start at frame 0 at 30 FPS.
// Markers follow hand/foot extension in the supplied Mixamo FBX files.
export const MELEE_MOVES: Record<MeleeAction, MeleeMove> = {
  punchJab: { action: "punchJab", duration: 31 / 30, hits: [17 / 30], damage: 12, range: 74 },
  punchCombo: { action: "punchCombo", duration: 66 / 30, hits: [19 / 30, 26 / 30, 34 / 30, 41 / 30], damage: 12, range: 74 },
  punchHook: { action: "punchHook", duration: 65 / 30, hits: [34 / 30], damage: 24, range: 80 },
  kickSide: { action: "kickSide", duration: 38 / 30, hits: [15 / 30], damage: 16, range: 94 },
  kickLow: { action: "kickLow", duration: 36 / 30, hits: [14 / 30], damage: 16, range: 90 },
  kickRoundhouse: { action: "kickRoundhouse", duration: 40 / 30, hits: [18 / 30], damage: 16, range: 94 },
  // Four turns sweep nearby targets; each target may be hit once per full action.
  kickHurricane: { action: "kickHurricane", duration: 71 / 30, hits: [0.1, 18 / 30, 36 / 30, 54 / 30], damage: 16, range: 94, sweep: true },
};
export type ActiveMelee = { move: MeleeMove; startedAt: number; aimX: number; aimZ: number; nextHit: number; hitTargets: Set<number> };

export class MeleeSystem {
  active?: ActiveMelee;
  private punchIndex = 0;
  private kickIndex = 0;
  private queued?: { request: MeleeRequest; expiresAt: number };

  cancel() { this.active = undefined; this.queued = undefined; }
  request(request: MeleeRequest, now: number) {
    // Keep one recent follow-up; repeated taps cannot build an unbounded backlog.
    this.queued = { request, expiresAt: now + 0.4 };
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
