import { AttackLoadout } from "../src/attack-modes.js";
import { CHARGE_SECONDS, CombatInputBuffer } from "../src/combat-input.js";
import { MELEE_MOVES, MeleeSystem, type MeleeAction } from "../src/melee.js";
import { DEFAULT_WEAPON } from "../src/config.js";
import { WeaponSystem } from "../src/weapon.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const loadout = new AttackLoadout();
assert(loadout.current === "unarmed" && !loadout.select("smg"), "Start empty-handed; unowned equipment cannot be selected");
assert(!loadout.neighbor(-1) && !loadout.neighbor(1), "No phantom alternatives before pickup");
loadout.unlock("smg");
assert(loadout.current === "unarmed" && loadout.neighbor(1) === "smg", "Pickup unlocks gun without replacing selected mode");
assert(loadout.select("smg") && loadout.neighbor(-1) === "unarmed", "Can switch back to fists");
assert(!loadout.neighbor(1), "Two modes do not duplicate the same option on both sides");

const input = new CombatInputBuffer();
input.press("j", "punch", 0);
input.release("j", 0.1);
assert(input.consume(0.2).meleeRequests[0]?.kind === "punch", "Short tap survives between render frames");
assert(!input.consume(0.3).meleeRequests.length, "Tap consumed once");
input.press("j", "punch", 1);
input.press("touch", "kick", 1.1);
input.release("j", 1.2);
const mixed = input.consume(1.3);
assert(!mixed.meleeRequests[0]?.charged && mixed.kickCharge > 0, "Independent fingers do not cancel each other");
input.release("touch", 1.1 + CHARGE_SECONDS + 0.01);
assert(input.consume(2).meleeRequests[0]?.charged, "Holding kick reaches charged action");
input.press("cancel", "punch", 2);
input.release("cancel", 3, true);
assert(!input.consume(3).meleeRequests.length, "Pointer cancellation cannot release an attack");
input.press("j", "punch", 3);
input.setMode("smg");
input.release("j", 4);
assert(!input.consume(4).fireHeld, "Held punch cannot become a gunshot during mode switch");
input.press("mouse", "punch", 4);
input.release("mouse", 4.01);
assert(input.consume(4.1).fireHeld && !input.consume(4.2).fireHeld, "Short gun tap queues exactly one frame");
input.press("j", "punch", 5);
input.reset();
assert(!input.consume(6).fireHeld, "Blur or pause clears held firing");

const melee = new MeleeSystem();
let now = 0;
const run = (kind: "punch" | "kick", charged: boolean, expected: MeleeAction) => {
  melee.request({ kind, charged }, now);
  melee.startQueued(now, 0, -1, () => true);
  assert(melee.active?.move.action === expected, `Expected ${expected}`);
  const move = MELEE_MOVES[expected];
  assert(!melee.advance(now + move.hits[0] - 0.001).length, "No damage before contact marker");
  assert(melee.advance(now + move.duration + 0.001).length === move.hits.length, "Skipped frames still deliver each marker once");
  assert(!melee.advance(now + move.duration + 0.001).length && !melee.active, "No repeated damage after completion");
  now += move.duration + 0.1;
};
run("punch", false, "punchJab");
run("punch", false, "punchCombo");
run("punch", true, "punchHook");
run("punch", false, "punchJab");
run("kick", false, "kickSide");
run("kick", false, "kickLow");
run("kick", true, "kickHurricane");
run("kick", false, "kickRoundhouse");
run("kick", false, "kickSide");
assert(MELEE_MOVES.punchHook.damage === MELEE_MOVES.punchJab.damage * 2, "Charged hook doubles per-punch damage");
melee.request({ kind: "punch", charged: false }, now);
melee.startQueued(now, 0, -1, () => false);
assert(!melee.active, "Unavailable animation cannot deal invisible damage");
melee.request({ kind: "punch", charged: false }, now);
melee.startQueued(now + 1, 0, -1, () => true);
assert(!melee.active, "Old rapid taps do not create a delayed attack backlog");
melee.request({ kind: "kick", charged: true }, now);
melee.startQueued(now, 0, -1, () => true);
melee.cancel();
assert(!melee.advance(now + 3).length, "Switching equipment cancels remaining melee markers");

// A moving punch releases the legs immediately; kicks release only after contact
// and retraction. A buffered follow-up must never cut off combo hit markers.
const flowing = new MeleeSystem();
flowing.request({ kind: "punch", charged: false }, 0);
flowing.startQueued(0, 0, -1, () => true);
assert(!flowing.locksMovement, "Punching must allow movement from the first frame");
flowing.request({ kind: "punch", charged: false }, 0.1);
assert(!flowing.releaseRecovery(0.7, true), "Cannot cancel before recovery or skip contact");
flowing.advance(0.8);
assert(flowing.releaseRecovery(0.8, true) === "punchJab", "Recent follow-up can use the recovery window");
flowing.startQueued(0.8, 0, -1, () => true);
assert(flowing.active?.move.action === "punchCombo", "The queued normal punch continues the cycle");
flowing.request({ kind: "kick", charged: false }, 0.9);
let comboHits = 0;
for (const t of [0.64, 0.87, 1.14, 1.37]) {
  comboHits += flowing.advance(0.8 + t).length;
  assert(!flowing.releaseRecovery(0.8 + t, true), "Follow-up cannot interrupt a combo's active strikes");
}
assert(comboHits === 4, "Buffered input preserves all four combo contacts");
assert(flowing.releaseRecovery(0.8 + 50 / 30, true) === "punchCombo", "Combo recovery can chain before full clip ends");
flowing.startQueued(0.8 + 50 / 30, 0, -1, () => true);
assert(flowing.locksMovement, "Kick keeps its support foot planted during the strike");
const kickStart = 0.8 + 50 / 30;
assert(flowing.advance(kickStart + 0.5).length === 1, "Kick still deals damage at original contact");
assert(!flowing.releaseRecovery(kickStart + 0.6, true), "Extended kick cannot be canceled early");
assert(flowing.releaseRecovery(kickStart + 26 / 30, true) === "kickSide" && !flowing.locksMovement,
  "Moving again at kick retraction avoids waiting for the full 1.27-second clip");
assert(!flowing.advance(kickStart + 2).length, "Canceled recovery cannot deal late damage");
const standing = new MeleeSystem();
standing.request({ kind: "kick", charged: false }, 0);
standing.startQueued(0, 0, -1, () => true);
standing.advance(1);
assert(!standing.releaseRecovery(1, false) && standing.active, "No movement or follow-up: retain full standing animation");

const weapon = new WeaponSystem({ ...DEFAULT_WEAPON, magazineSize: 1, initialReserveAmmo: 3 });
weapon.update(0, true, false);
weapon.update(0.1, false, false);
assert(weapon.update(0.2, false, false).reloadStarted, "Empty gun reloads even after firing input is released");
weapon.holster();
assert(weapon.getSnapshot(2).magazineAmmo === 0 && weapon.getSnapshot(2).reserveAmmo === 3, "Switching away cannot refill or lose ammo");
assert(weapon.update(2, false, false).reloadStarted, "Switching back restarts empty reload");
assert(weapon.update(3.31, false, false).reloadCompleted, "Automatic reload completes");
weapon.update(4, true, false);
weapon.holster();
assert(!weapon.update(4.2, false, false).fired && weapon.getSnapshot(4.2).magazineAmmo === 1, "Holstering cancels an unfired bullet without spending ammo");
console.log("Combat controls passed: owned modes, tap/hold/cancel, independent inputs, source action cycles, contact timing, automatic reload and holstering.");
