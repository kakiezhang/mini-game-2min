// Regression checks against the shipped Mixamo skeleton and animation tracks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CharacterAnimationController } from '../.animation-test-dist/src/characters/animation-controller.js';
import { MELEE_MOVES } from '../.animation-test-dist/src/melee.js';

globalThis.ProgressEvent ??= class { constructor(type, values) { Object.assign(this, values); } };
const buffer = fs.readFileSync(new URL('../ksman_v3_unarmed_moves_review_1k_meshopt.glb', import.meta.url));
const length = buffer.readUInt32LE(12);
const json = JSON.parse(buffer.subarray(20, 20 + length).toString());
json.buffers[0].uri = `data:application/octet-stream;base64,${buffer.subarray(28 + length).toString('base64')}`;
for (const mesh of json.meshes) for (const primitive of mesh.primitives) delete primitive.material;
delete json.materials; delete json.textures; delete json.images;
for (const key of ['extensionsUsed', 'extensionsRequired']) {
  if (json[key]) json[key] = json[key].filter(value => value !== 'EXT_texture_webp');
}
const asset = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(JSON.stringify(json), '');
const clips = {
  idle: 'Idle', walk: 'Walk', run: 'UnarmedRun', punchJab: 'PunchJab',
  punchCombo: 'PunchFourCombo', punchHook: 'PunchHook', kickSide: 'KickSide',
  kickLow: 'KickLow', kickRoundhouse: 'KickRoundhouse', kickHurricane: 'KickHurricane',
};
const punches = ['punchJab', 'punchCombo', 'punchHook'];
const create = (layered = true, onlyGait = false) => {
  const root = clone(asset.scene);
  const controller = new CharacterAnimationController(root, asset.animations, {
    clips: onlyGait ? { idle: clips.idle, walk: clips.walk, run: clips.run } : clips,
    runSpeedThreshold: 1.4, movingUpperBodyActions: layered ? punches : undefined,
  });
  const bones = [];
  root.traverse(node => { if (node.isBone) bones.push(node); });
  return { root, controller, bones };
};
const isUpper = bone => {
  for (let node = bone; node; node = node.parent) if (/Spine$/.test(node.name)) return true;
  return false;
};
let maxError = 0;
let maxUpperFrameError = 0;
let maxUpperPositionError = 0;
const sameUpperFrame = (actual, reference) => {
  actual.root.updateMatrixWorld(true); reference.root.updateMatrixWorld(true);
  const pelvis = actual.root.getObjectByName('mixamorigHips').getWorldPosition(new THREE.Vector3());
  const sourcePelvis = reference.root.getObjectByName('mixamorigHips').getWorldPosition(new THREE.Vector3());
  for (const bone of actual.bones.filter(isUpper)) {
    const other = reference.root.getObjectByName(bone.name);
    const rotation = bone.getWorldQuaternion(new THREE.Quaternion()).normalize();
    const sourceRotation = other.getWorldQuaternion(new THREE.Quaternion()).normalize();
    const error = rotation.angleTo(sourceRotation);
    maxUpperFrameError = Math.max(maxUpperFrameError, error);
    assert.ok(error < 1e-5, `${bone.name} inherited a different pelvis frame: ${THREE.MathUtils.radToDeg(error)} degrees`);
    const position = bone.getWorldPosition(new THREE.Vector3()).sub(pelvis);
    const sourcePosition = other.getWorldPosition(new THREE.Vector3()).sub(sourcePelvis);
    const positionError = position.distanceTo(sourcePosition);
    maxUpperPositionError = Math.max(maxUpperPositionError, positionError);
    assert.ok(positionError < 1e-5, `${bone.name} gained extra motion relative to the pelvis: ${positionError}`);
  }
};
const samePose = (actual, reference, filter = () => true) => {
  for (const bone of actual.bones.filter(filter)) {
    const other = reference.root.getObjectByName(bone.name);
    const error = Math.max(bone.position.distanceTo(other.position),
      bone.quaternion.clone().normalize().angleTo(other.quaternion.clone().normalize()), bone.scale.distanceTo(other.scale));
    maxError = Math.max(maxError, error);
    assert.ok(error < 1e-6, `${bone.name} diverged from its source layer: ${error}`);
  }
};
const pose = rig => rig.bones.map(b => [...b.position.toArray(), ...b.quaternion.toArray()]);
const noJump = (rig, change) => {
  const before = pose(rig); change();
  const after = pose(rig);
  assert.ok(before.every((row, i) => row.every((value, j) => Math.abs(value - after[i][j]) < 1e-6)), 'Pose jumped at zero elapsed time');
};

// Every standing attack and every moving kick must retain the full source pose.
for (const [action, move] of Object.entries(MELEE_MOVES)) {
  for (const moving of [false, ...(move.kind === 'kick' ? [true] : [])]) {
    const rig = create(), reference = create(false);
    for (const target of [rig, reference]) {
      target.controller.setMovement(moving ? 1 : 0, 0);
      target.controller.update(0.3);
      target.controller.playOneShot(action, { durationSeconds: move.duration });
    }
    for (let t = 0; t < move.duration + 0.3; t += 1 / 60) {
      rig.controller.update(1 / 60); reference.controller.update(1 / 60);
      samePose(rig, reference);
    }
    rig.controller.dispose(); reference.controller.dispose();
  }
}

// Walking/running punches must keep the pelvis and feet at the same gait phase.
for (const speed of [1, 1.5]) for (const action of punches) {
  const rig = create(), gait = create(false, true), punch = create(false);
  for (const target of [rig, gait, punch]) {
    target.controller.setMovementSpeedScale(speed);
    target.controller.setMovement(1, 0);
    target.controller.update(0.37);
  }
  noJump(rig, () => rig.controller.playOneShot(action));
  punch.controller.playOneShot(action);
  const duration = MELEE_MOVES[action].duration;
  for (let t = 0; t < duration - 0.02; t += 1 / 60) {
    for (const target of [rig, gait, punch]) target.controller.update(1 / 60);
    samePose(rig, gait, b => !isUpper(b));
    sameUpperFrame(rig, punch);
  }
  assert.equal(rig.controller.getSnapshot().lowerBodyState, speed > 1 ? 'run' : 'walk');
  assert.equal(rig.controller.playOneShot('shoot'), false, 'Unarmed controller must never play Shoot');
  assert.ok(rig.controller.getSnapshot().actions.every(a => !/Rifle|Shoot|Reload/.test(a.name)), 'Armed clip leaked into unarmed animation');
  noJump(rig, () => rig.controller.stopOneShot(action));
  for (let i = 0; i < 20; i++) { rig.controller.update(1 / 60); gait.controller.update(1 / 60); }
  samePose(rig, gait);
  for (const target of [rig, gait, punch]) target.controller.dispose();
}

// Moving or stopping during a punch changes the legs without restarting it.
const rig = create();
rig.controller.playOneShot('punchCombo'); rig.controller.update(0.3);
noJump(rig, () => rig.controller.setMovement(1, 0));
rig.controller.update(0.2);
assert.equal(rig.controller.getSnapshot().lowerBodyState, 'walk');
assert.equal(rig.controller.getSnapshot().oneShotState, 'punchCombo');
noJump(rig, () => { rig.controller.setMovementSpeedScale(1.5); rig.controller.setMovement(1, 0); });
rig.controller.update(0.2);
assert.equal(rig.controller.getSnapshot().lowerBodyState, 'run');
noJump(rig, () => rig.controller.setMovement(0, 0));
rig.controller.update(0.2);
assert.equal(rig.controller.getSnapshot().lowerBodyState, 'idle');
assert.equal(rig.controller.getSnapshot().oneShotState, 'punchCombo');
rig.controller.dispose();

// Repeated zero-delta sampling must not apply pelvis compensation cumulatively.
const sampled = create();
sampled.controller.setMovementSpeedScale(1.5); sampled.controller.setMovement(1, 0);
sampled.controller.update(0.4); sampled.controller.playOneShot('punchJab'); sampled.controller.update(0.5);
for (let i = 0; i < 120; i++) noJump(sampled, () => sampled.controller.update(0));
sampled.controller.dispose();
console.log(JSON.stringify({ test: 'Mixamo unarmed movement layers', maxError,
  maxUpperFrameErrorDegrees: THREE.MathUtils.radToDeg(maxUpperFrameError), maxUpperPositionError,
  standingSourcePoses: true, noArmedClips: true, noRepeatedCorrection: true,
  kicksFullBody: true, walkingAndRunningPunches: true, gaitPhasePreserved: true, zeroTimeTransitions: true }));
