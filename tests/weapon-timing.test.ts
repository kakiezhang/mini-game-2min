import { DEFAULT_WEAPON } from "../src/config.js";
import { WeaponSystem } from "../src/weapon.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const weapon = new WeaponSystem(DEFAULT_WEAPON);
const first = weapon.update(0, true, false);
assert(first.shotStarted && !first.fired, "J starts Shoot before a bullet is created");
assert(weapon.getSnapshot(0).magazineAmmo === 20, "Aiming does not consume ammo");
assert(!weapon.update(0.099, false, false).fired, "The bullet waits for the attack point");
assert(weapon.update(0.1, false, false).fired, "A quick J tap fires once at the attack point");
assert(!weapon.update(0.1, false, false).fired, "Crossing the attack point fires only once");
assert(weapon.getSnapshot(0.1).magazineAmmo === 19, "Ammo is consumed at the attack point");

assert(weapon.update(0.2, true, false).shotStarted, "Held J starts the next attack at 5 Hz");
assert(!weapon.update(0.299, true, false).fired, "The second bullet also waits for the marker");
assert(weapon.update(0.3, true, false).fired, "The second bullet preserves 0.2-second cadence");

assert(weapon.update(0.4, true, false).shotStarted, "A third attack can begin");
const reload = weapon.update(0.45, false, true);
assert(reload.reloadStarted && !reload.fired, "Reload cancels an unfired attack");
assert(!weapon.update(0.6, false, false).fired, "Canceled attack cannot fire during reload");
assert(weapon.getSnapshot(0.6).magazineAmmo === 18, "Canceled attack does not consume ammo");
console.log("Weapon timing tests passed: windup, tap commitment, 5 Hz cadence, ammo timing, reload cancellation.");
