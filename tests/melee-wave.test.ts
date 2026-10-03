import * as THREE from "three";
import { AttackGesture } from "../src/attack-gesture.js";
import { CombatInputBuffer } from "../src/combat-input.js";
import { MeleeSystem, PUNCH_PLAYBACK_RATES, type MeleeHitEvent } from "../src/melee.js";
import { AttackShape, JAB_WAVE, sweptCircleIntersectsBand } from "../src/attack-shape.js";
import { MeleeWaveSystem, type WaveTarget } from "../src/melee-wave.js";
import { NavigationWorld } from "../src/navigation.js";
import { projectAttackDrag } from "../src/input.js";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const near = (a: number, b: number, message: string) => assert(Math.abs(a - b) < 1e-6, message);
const origin = { x: 500, z: 500 };
const target = (id: number, x: number, z: number, radius = 10): WaveTarget => ({ id, previous: { x, z }, position: { x, z }, radius, alive: true });
function event(attackId = 1): MeleeHitEvent {
  const melee = new MeleeSystem({ cycle: ["punchJab"], charged: "punchJab" });
  melee.request({ kind: "punch", charged: false, aimX: 0, aimZ: -1 }, 0);
  melee.startQueued(0, 1, 0, () => true);
  const hit = melee.advanceEvents(0.6)[0];
  return { ...hit, attackId, occurredAt: 0 };
}
const crowd = [target(1, 480, 420), target(2, 520, 410), target(3, 500, 360), target(4, 500, 525), target(5, 600, 485)];
for (const dt of [1 / 120, 1 / 30, 0.3]) {
  const waves = new MeleeWaveSystem(new NavigationWorld(1000, 1000));
  assert(waves.spawn(event(), origin), "First marker emits a wave");
  assert(!waves.spawn(event(), origin), "Same attack marker must not emit twice");
  const ids: number[] = [];
  for (let t = 0; t < 0.4; t += dt) ids.push(...waves.advance(t, t + dt, crowd).map(hit => hit.targetId));
  assert(ids.sort().join() === "1,2", `Multi-target/range/de-dup differs at frame duration ${dt}: ${ids}`);
  assert(!waves.waves.length, "Expired effects must be removed");
  assert(!waves.spawn(event(), origin), "Late replay after fade cannot deal damage again");
}
const inert = new MeleeWaveSystem(new NavigationWorld(1000, 1000));
inert.spawn(event(), origin);
assert(!inert.advance(0, 0.3, [{ ...crowd[0], alive: false }, { ...crowd[1], spawning: true }]).length, "Dead and spawning targets excluded");

const boundary = new AttackShape(origin, { x: 0, z: -1 }, JAB_WAVE, new NavigationWorld(1000, 1000));
const band = boundary.writeBand(0, 112, []);
assert(sweptCircleIntersectsBand({ x: 500, z: 384 }, { x: 500, z: 384 }, 5, band), "Target edge can touch the visible range");
assert(!sweptCircleIntersectsBand({ x: 500, z: 382 }, { x: 500, z: 382 }, 5, band), "No hidden range bonus");
const nearOrigin = new MeleeWaveSystem(new NavigationWorld(1000, 1000));
nearOrigin.spawn(event(), origin);
assert(nearOrigin.advance(0, 0.001, [target(1, 500, 500, 12)]).length === 1, "Spawn-overlapping target takes exactly one wave hit");

const fast = new MeleeWaveSystem(new NavigationWorld(1000, 1000));
fast.spawn(event(), origin);
fast.advance(0, 0.1, []);
assert(fast.advance(0.1, 0.2, [{ ...target(1, 650, 440, 2), previous: { x: 350, z: 440 } }]).length === 1,
  "Fast target crossing between frames must not tunnel through the band");

const world = new NavigationWorld(1000, 1000);
const wall = world.addObstacle(500, 440, 30, 2);
const blocked = target(1, 500, 410, 8), side = target(2, 545, 420, 8);
const walls = new MeleeWaveSystem(world);
walls.spawn(event(), origin);
assert(walls.advance(0, 0.3, [blocked, side]).map(hit => hit.targetId).join() === "2", "Thin wall blocks behind it while leaving the open side hittable");
const blockedShape = new AttackShape(origin, { x: 0, z: -1 }, JAB_WAVE, world);
assert(!sweptCircleIntersectsBand(blocked.position, blocked.position, blocked.radius, blockedShape.writeBand(0, 112, [])),
  "Visible preview must agree with wall collision");

for (const openAt of [0.1, 0.17]) {
  world.setObstacleActive(wall, true);
  const doors = new MeleeWaveSystem(world); doors.spawn(event(), origin);
  doors.advance(0, openAt, [blocked]); world.setObstacleActive(wall, false);
  const hits = doors.advance(openAt, 0.3, [blocked]);
  assert(hits.length === (openAt < 0.15 ? 1 : 0), "Only wave segments that already hit the closed door stay blocked after opening");
}

const buffer = new CombatInputBuffer();
const gesture = new AttackGesture({ x: 0, z: -1 });
gesture.move(20, 0, (x, y) => ({ x, z: y }));
buffer.press("touch-a", "punch", 0, gesture.direction);
buffer.press("touch-b", "kick", 0.1, { x: 0, z: 1 });
buffer.release("touch-a", 0.2);
const request = buffer.consume(0.3).meleeRequests[0];
assert(request.aimX === 1 && request.aimZ === 0, "Other finger must not overwrite punch snapshot");
buffer.release("touch-b", 0.8);
assert(buffer.consume(0.8).meleeRequests[0].charged, "Directional gesture preserves charged input");
gesture.move(0, 0, () => ({ x: 0, z: -1 }));
assert(gesture.canceled, "Returning a dragged gesture to center cancels");
buffer.press("cancel", "punch", 1, gesture.direction); buffer.setAim("cancel", gesture.direction, gesture.canceled);
buffer.release("cancel", 2); assert(!buffer.consume(2).meleeRequests.length, "Canceled gesture never produces an attack");
gesture.move(0, -15, (x, y) => ({ x, z: y })); assert(!gesture.canceled, "Dragging out again resumes aiming");
const tap = new AttackGesture({ x: 0, z: -1 }); tap.move(2, 0, () => ({ x: 1, z: 0 }));
assert(!tap.canceled && tap.direction.z === -1, "Small undragged tap keeps remembered direction");
buffer.press("held", "punch", 3, { x: 1, z: 0 }); buffer.setMode("smg"); buffer.release("held", 4);
assert(!buffer.consume(4).fireHeld && !buffer.consume(4).meleeRequests.length, "Switch cancels held gesture");

const queue = new MeleeSystem(); queue.request(request, 0); request.aimX = -1;
queue.startQueued(0, 0, 1, () => true);
assert(queue.active?.aimX === 1 && queue.active.aimZ === 0, "Queued direction is copied and cannot change with movement or caller mutation");
const marker = queue.advanceEvents(1.1)[0];
near(marker.occurredAt, 17 / 30, "Marker keeps exact sub-frame time");
assert(marker.markerIndex === 0 && !queue.advanceEvents(1.1).length, "Marker emitted only once");

// Faster playback must move the animation, hit and follow-up window together.
const responsive = new MeleeSystem({ cycle: ["punchJab"], charged: "punchJab" }, PUNCH_PLAYBACK_RATES);
responsive.request({ kind: "punch", charged: false, aimX: 0, aimZ: -1 }, 0);
let playbackDuration = 0;
responsive.startQueued(0, 1, 0, move => { playbackDuration = move.duration; return true; });
assert(!responsive.advanceEvents(0.22).length, "Fast jab cannot hit before the fist extension marker");
const fastMarker = responsive.advanceEvents(0.24);
assert(fastMarker.length === 1, "Responsive jab emits within 240ms of release");
near(fastMarker[0].occurredAt / playbackDuration, 17 / 31, "Animation and wave keep the original contact pose phase");
responsive.request({ kind: "punch", charged: false, aimX: 1, aimZ: 0 }, 0.25);
assert(!responsive.releaseRecovery(0.31, false), "Follow-up cannot cut off the recovery early");
assert(responsive.releaseRecovery(0.32, false) === "punchJab", "A queued jab can follow at 320ms");
responsive.startQueued(0.32, 0, -1, () => true);
assert(responsive.active?.aimX === 1, "Fast follow-up keeps its own aim");
assert(responsive.advanceEvents(1).length === 1 && !responsive.advanceEvents(1).length,
  "Long frame across fast jab still emits only once");

// Projection must preserve screen direction under an oblique camera in both orientations.
for (const [width, height] of [[390, 844], [844, 390]]) {
  const camera = new THREE.OrthographicCamera(-300 * width / height, 300 * width / height, 300, -300, 1, 2000);
  camera.position.set(840, 620, 920); camera.lookAt(500, 0, 500); camera.updateMatrixWorld(true);
  for (const [dx, dy] of [[20, 0], [0, -20], [-20, 15]]) {
    const aim = projectAttackDrag(camera, 500, 500, dx, dy, width, height);
    const a = new THREE.Vector3(500, 0, 500).project(camera);
    const b = new THREE.Vector3(500 + aim.x * 50, 0, 500 + aim.z * 50).project(camera);
    const sx = (b.x - a.x) * width, sy = -(b.y - a.y) * height;
    near((sx * dx + sy * dy) / Math.hypot(sx, sy) / Math.hypot(dx, dy), 1, "Screen drag and ground preview disagree");
  }
}
console.log("Directed melee passed: immutable aim, gestures/charge/cancel, projection, exact markers, multi-target waves, fast targets, bounds, thin walls and dynamic doors.");
