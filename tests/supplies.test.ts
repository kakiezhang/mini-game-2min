import { chooseSupplyKind, pickSupplyPosition } from "../src/supplies.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const samples = [0, 0.5, 0.5, 0.5];
let index = 0;
const position = pickSupplyPosition(
  { x: 100, z: 100 }, 80, 160,
  candidate => candidate.x < 100,
  () => samples[index++],
  2,
);
assert(position !== undefined && position.x < 100, "Spawn retries after a rejected location");
assert(Math.hypot(position.x - 100, position.z - 100) >= 80, "Spawn stays outside the minimum radius");
assert(pickSupplyPosition({ x: 0, z: 0 }, 80, 160, () => false, () => 0, 3) === undefined,
  "An obstructed supply is not placed in an invalid location");
assert(chooseSupplyKind(false, false, () => 0.99) === "smg", "An unarmed player gets a gun supply");
assert(chooseSupplyKind(true, true, () => 0.3) === "medkit", "Low health can select a medkit");
assert(chooseSupplyKind(true, false, () => 0.3) === "ammo", "Healthy players can receive ammunition");
console.log("Supply tests passed: valid random positions, retries, and need based type selection.");
