import type { AttackMode } from "./attack-modes.js";
import { normalizeAim, type AttackDirection } from "./attack-gesture.js";

export type MeleeKind = "punch" | "kick";
export type MeleeRequest = { kind: MeleeKind; charged: boolean; aimX?: number; aimZ?: number; requestedAt?: number };
export const CHARGE_SECONDS = 0.65;

/** Preserve taps between frames, and discard held inputs when the loadout changes. */
export class CombatInputBuffer {
  private mode: AttackMode = "unarmed";
  private readonly presses = new Map<string, { kind: MeleeKind; startedAt: number; aim?: AttackDirection; canceled: boolean }>();
  private requests: MeleeRequest[] = [];
  private fireQueued = false;

  setMode(mode: AttackMode) {
    if (mode === this.mode) return;
    this.reset();
    this.mode = mode;
  }
  reset() {
    this.presses.clear();
    this.requests = [];
    this.fireQueued = false;
  }
  press(source: string, kind: MeleeKind, now: number, aim?: AttackDirection) {
    if (this.presses.has(source) || (this.mode === "smg" && kind === "kick")) return;
    this.presses.set(source, { kind, startedAt: now, aim: aim && normalizeAim(aim), canceled: false });
    if (this.mode === "smg") this.fireQueued = true;
  }
  setAim(source: string, aim: AttackDirection, canceled = false) {
    const press = this.presses.get(source);
    if (!press) return;
    press.aim = normalizeAim(aim);
    press.canceled = canceled;
  }
  release(source: string, now: number, canceled = false) {
    const press = this.presses.get(source);
    if (!press) return;
    this.presses.delete(source);
    if (!canceled && !press.canceled && this.mode === "unarmed") {
      this.requests.push({ kind: press.kind, charged: now - press.startedAt >= CHARGE_SECONDS,
        ...(press.aim ? { aimX: press.aim.x, aimZ: press.aim.z, requestedAt: now } : {}) });
    }
    if (canceled && this.mode === "smg" && !this.presses.size) this.fireQueued = false;
  }
  consume(now: number) {
    const latest = this.mode === "unarmed" ? [...this.presses.values()].filter(p => p.aim).at(-1) : undefined;
    const charge = (kind: MeleeKind) => this.mode === "unarmed"
      ? Math.min(1, Math.max(0, ...[...this.presses.values()].filter(p => p.kind === kind)
        .map(p => (now - p.startedAt) / CHARGE_SECONDS))) : 0;
    const result = {
      fireHeld: this.mode === "smg" && (this.fireQueued || this.presses.size > 0),
      meleeRequests: this.requests,
      punchCharge: charge("punch"), kickCharge: charge("kick"),
      aimPreview: latest?.aim ? { ...latest.aim, kind: latest.kind, canceled: latest.canceled } : undefined,
    };
    this.requests = [];
    this.fireQueued = false;
    return result;
  }
}
