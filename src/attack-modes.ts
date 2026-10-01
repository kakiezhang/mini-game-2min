export type AttackMode = "unarmed" | "smg";
export const ATTACK_MODE_LABELS: Record<AttackMode, string> = { unarmed: "空手", smg: "冲锋枪" };
const MODE_ORDER: AttackMode[] = ["unarmed", "smg"];

export class AttackLoadout {
  private readonly owned = new Set<AttackMode>(["unarmed"]);
  current: AttackMode = "unarmed";

  has(mode: AttackMode) { return this.owned.has(mode); }
  unlock(mode: AttackMode) { this.owned.add(mode); }
  select(mode: AttackMode) {
    if (!this.has(mode) || mode === this.current) return false;
    this.current = mode;
    return true;
  }
  neighbor(direction: -1 | 1): AttackMode | undefined {
    const available = MODE_ORDER.filter(mode => this.has(mode));
    return available[available.indexOf(this.current) + direction];
  }
}
