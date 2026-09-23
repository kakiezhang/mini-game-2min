import * as THREE from "three";
import { CharacterAnimationController } from "../src/characters/animation-controller.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const near = (actual: number, expected: number, message: string) => assert(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} != ${expected}`);
const makeRig = (walkOnly = false) => {
  const root = new THREE.Group();
  const bone = new THREE.Bone();
  bone.name = "testBone";
  bone.position.x = 100; // Deliberately different bind pose to expose weight gaps.
  root.add(bone);
  const idle = new THREE.AnimationClip("Idle", 3, [new THREE.NumberKeyframeTrack("testBone.position[x]", [0, 3], [2, 2])]);
  const walk = new THREE.AnimationClip("Walk", 1, [new THREE.NumberKeyframeTrack("testBone.position[x]", [0, 1], [10, 20])]);
  const shoot = new THREE.AnimationClip("Shoot", 0.4, [new THREE.NumberKeyframeTrack("testBone.position[x]", [0, 0.4], [30, 40])]);
  const controller = new CharacterAnimationController(root, walkOnly ? [walk] : [idle, walk, shoot], { clips: { idle: /idle/i, walk: /walk/i, shoot: /shoot/i } });
  return { root, bone, controller };
};
const totalWeight = (controller: CharacterAnimationController) => controller.getSnapshot().actions.reduce((sum, action) => sum + action.weight, 0);

const { bone, controller } = makeRig();
near(bone.position.x, 2, "Initial pose is fully applied without bind-pose fade");
near(totalWeight(controller), 1, "Initial weights");
controller.setMovement(1, 0);
controller.update(0.06);
near(totalWeight(controller), 1, "Halfway weights");
near(controller.getSnapshot().actions.find(action => action.state === "walk")!.weight, 0.5, "Halfway Walk weight");
const beforeReverse = bone.position.x;
const idleTime = controller.getSnapshot().actions[0].time;
controller.setMovement(0, 0);
near(bone.position.x, beforeReverse, "Reversing preserves current pose");
near(controller.getSnapshot().actions[0].time, idleTime, "Reversing preserves contributing clip time");
for (let index = 0; index < 120; index++) {
  const before = bone.position.x;
  controller.setMovement(index % 2, 0);
  near(bone.position.x, before, "Rapid changes do not jump at zero elapsed time");
  controller.update(0.01);
  near(totalWeight(controller), 1, "Rapid reversal weights remain normalized");
  assert(bone.position.x < 21, "No bind pose contribution during interrupted fades");
}
controller.setMovement(0, 0);
controller.update(0.12);
near(bone.position.x, 2, "Returns to full Idle");
assert(!controller.getSnapshot().transitioning, "Transition finishes");
const beforeZero = controller.getSnapshot().actions[0].time;
controller.update(0);
near(controller.getSnapshot().actions[0].time, beforeZero, "Paused time stays still");
controller.setMovement(0.08, 0);
assert(controller.getSnapshot().state === "idle", "Input deadzone matches game");
controller.setState("attack");
assert(controller.getSnapshot().state === "idle", "Missing clips keep current state");
controller.update(7);
assert(controller.getSnapshot().actions[0].time < 3, "Idle continues looping");

// Shoot owns the pose once, while movement keeps updating its return state.
const beforeShoot = bone.position.x;
assert(controller.playOneShot("shoot"), "Shoot clip starts");
near(bone.position.x, beforeShoot, "Shoot begins without a zero-time pose jump");
near(totalWeight(controller), 1, "Shoot transition weights start normalized");
controller.update(0.04);
near(controller.getSnapshot().actions.find(action => action.state === "shoot")!.weight, 0.5, "Shoot fades in over 0.08 seconds");
near(totalWeight(controller), 1, "Shoot blend weights remain normalized");
controller.setMovement(1, 0);
assert(controller.getSnapshot().state === "shoot", "Movement does not interrupt Shoot");
assert(controller.getSnapshot().locomotionState === "walk", "Movement updates Shoot fallback");
controller.update(0.36);
assert(controller.getSnapshot().state === "walk", "Finished Shoot starts returning to Walk");
assert(controller.getSnapshot().oneShotState === undefined, "Finished Shoot releases its action lock");
controller.update(0.12);
near(controller.getSnapshot().actions.find(action => action.state === "walk")!.weight, 1, "Shoot returns fully to Walk");

controller.playOneShot("shoot");
controller.update(0.2);
const shootAction = controller.getSnapshot().actions.find(action => action.state === "shoot")!;
assert(shootAction.time > 0.19, "Shoot advances before repeat");
controller.playOneShot("shoot");
near(controller.getSnapshot().actions.find(action => action.state === "shoot")!.time, 0, "Rapid Shoot restarts the one-shot clip");
near(totalWeight(controller), 1, "Rapid Shoot has no weight gap");
controller.setMovement(0, 0);
controller.update(0.4);
assert(controller.getSnapshot().state === "idle", "Shoot uses latest Idle fallback");
controller.update(0.12);
near(controller.getSnapshot().actions.find(action => action.state === "idle")!.weight, 1, "Standing Shoot returns fully to Idle");
assert(!controller.playOneShot("reload"), "Missing one-shot clip reports failure");

const legacy = makeRig(true);
near(legacy.bone.position.x, 15, "Walk-only model freezes at configured Idle pose");
legacy.controller.update(1);
near(legacy.bone.position.x, 15, "Legacy Idle remains frozen");
legacy.controller.setMovement(1, 0);
legacy.controller.update(0.1);
near(legacy.bone.position.x, 16, "Legacy Walk resumes");
legacy.controller.setMovement(0, 0);
near(legacy.bone.position.x, 15, "Legacy returns to Idle");
const independent = makeRig();
controller.setMovement(1, 0);
controller.update(0.1);
near(independent.bone.position.x, 2, "Instances remain independent");
controller.dispose(); legacy.controller.dispose(); independent.controller.dispose();
console.log("Character animation tests passed: initialization, blending, reversals, one-shots, fallback, repeat actions, independence.");
