// Run after TypeScript compilation via npm run test:animation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CharacterAnimationController } from '../.animation-test-dist/src/characters/animation-controller.js';
import { AnimatedCharacter } from '../.animation-test-dist/src/characters/animated-character.js';
import { createRifleJogClip } from '../.animation-test-dist/src/characters/jog-animation.js';

globalThis.ProgressEvent ??= class {
  constructor(type, values) { this.type = type; Object.assign(this, values); }
};
async function loadAsset(path) {
  const buffer = fs.readFileSync(path);
  const length = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + length).toString());
  json.buffers[0].uri = `data:application/octet-stream;base64,${buffer.subarray(28 + length).toString('base64')}`;
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  delete json.materials; delete json.textures; delete json.images;
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    if (json[key]) json[key] = json[key].filter(value => value !== 'EXT_texture_webp');
  }
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(JSON.stringify(json), '');
}
const asset = await loadAsset(process.env.CHARACTER_ASSET ?? new URL('../ksman_v3_walk_1k_meshopt.glb', import.meta.url));
for (const name of ['Idle', 'Walk', 'Shoot', 'RifleIdle', 'RifleWalk', 'RifleRun', 'Reload']) {
  assert.ok(asset.animations.some(clip => clip.name === name), `Missing ${name} clip`);
}
const armedClips = { idle: /^RifleIdle$/i, walk: /^RifleWalk$/i, run: /^RifleRun$/i, shoot: /^Shoot$/i, reload: /^Reload$/i };
const originalWalk = asset.animations.find(clip => clip.name === 'Walk');
const rifleWalk = asset.animations.find(clip => clip.name === 'RifleWalk');
const rifleRun = asset.animations.find(clip => clip.name === 'RifleRun');
const rifleJog = createRifleJogClip(rifleWalk, rifleRun);
assert.ok(rifleRun.duration > 0.5 && rifleRun.duration < 1, `Unexpected Run duration: ${rifleRun.duration}`);
assert.notDeepEqual(rifleRun.tracks.find(track => /Spine\.quaternion$/i.test(track.name))?.values,
  rifleWalk.tracks.find(track => /Spine\.quaternion$/i.test(track.name))?.values,
  'Imported Run must have its own pose');
const gaitMetrics = clip => {
  const sampleRoot = clone(asset.scene);
  const mixer = new THREE.AnimationMixer(sampleRoot);
  mixer.clipAction(clip).play();
  const leftFoot = sampleRoot.getObjectByName('mixamorigLeftFoot');
  const rightFoot = sampleRoot.getObjectByName('mixamorigRightFoot');
  const leftPosition = new THREE.Vector3(), rightPosition = new THREE.Vector3();
  let minimum = Infinity, maximumContact = -Infinity, maxFootSpread = 0;
  for (let index = 0; index <= 600; index += 1) {
    mixer.setTime((index / 600) * clip.duration);
    sampleRoot.updateMatrixWorld(true);
    leftFoot.getWorldPosition(leftPosition);
    rightFoot.getWorldPosition(rightPosition);
    const contact = Math.min(leftPosition.y, rightPosition.y);
    minimum = Math.min(minimum, contact);
    maximumContact = Math.max(maximumContact, contact);
    maxFootSpread = Math.max(maxFootSpread, Math.abs(leftPosition.z - rightPosition.z));
  }
  return { minimum, maximumContact, maxFootSpread };
};
const originalWalkGait = gaitMetrics(originalWalk);
const rifleWalkGait = gaitMetrics(rifleWalk);
const rifleJogGait = gaitMetrics(rifleJog);
const runGait = gaitMetrics(rifleRun);
assert.ok(rifleJogGait.maxFootSpread > rifleWalkGait.maxFootSpread
  && rifleJogGait.maxFootSpread < runGait.maxFootSpread,
`RifleJog stride is outside Walk/Run range: ${JSON.stringify(rifleJogGait)}`);
assert.ok(rifleJogGait.minimum >= rifleWalkGait.minimum - 0.01,
  `RifleJog foot sinks below Walk: ${rifleJogGait.minimum}`);
const walkFootMinimum = rifleWalkGait.minimum;
const runFootMinimum = runGait.minimum;
assert.ok(Math.abs(rifleWalkGait.maxFootSpread / originalWalkGait.maxFootSpread - 1) < 0.05,
  `RifleWalk stride differs from Walk: ${rifleWalkGait.maxFootSpread} vs ${originalWalkGait.maxFootSpread}`);
assert.ok(rifleWalkGait.minimum >= originalWalkGait.minimum - 0.005
  && rifleWalkGait.maximumContact <= originalWalkGait.maximumContact + 0.01,
`RifleWalk feet lose ground contact: ${JSON.stringify(rifleWalkGait)} vs ${JSON.stringify(originalWalkGait)}`);
const runRoot = clone(asset.scene);
const runReferenceRoot = clone(asset.scene);
const runController = new CharacterAnimationController(runRoot, asset.animations, {
  clips: armedClips, shootUpperBodyOnly: true, shootPulseEndSeconds: 0.3,
  jogFromWalkRun: true, runShootFromRun: true,
});
const runReference = new CharacterAnimationController(runReferenceRoot, asset.animations, {
  clips: { idle: armedClips.idle, walk: armedClips.walk, run: armedClips.run },
  jogFromWalkRun: true,
});
runController.setMovement(1, 0);
runReference.setMovement(1, 0);
runController.update(0.2);
runReference.update(0.2);
const gaitPhase = (runController.getSnapshot().actions.find(action => action.state === 'walk').time
  / (rifleWalk.duration / 3)) % 1;
runController.setMovementSpeedScale(1.2);
runReference.setMovementSpeedScale(1.2);
assert.equal(runController.getSnapshot().state, 'jog', 'Medium joystick distance must select RifleJog');
assert.ok(Math.abs(runController.getSnapshot().actions.find(action => action.state === 'jog').time
  / rifleJog.duration - gaitPhase) < 1e-6, 'Walk to Jog lost gait phase');
runController.setMovementSpeedScale(1.5);
runReference.setMovementSpeedScale(1.5);
assert.equal(runController.getSnapshot().state, 'run', 'Fast movement must select imported Run');
assert.ok(Math.abs(runController.getSnapshot().actions.find(action => action.state === 'run').time / rifleRun.duration - gaitPhase) < 1e-6,
  'Walk to Run lost normalized gait phase');
const lateWalkController = new CharacterAnimationController(clone(asset.scene), asset.animations, {
  clips: { idle: armedClips.idle, walk: armedClips.walk, run: armedClips.run },
  jogFromWalkRun: true,
});
lateWalkController.setMovement(1, 0);
lateWalkController.update(rifleWalk.duration * 0.8);
const lateWalkTime = lateWalkController.getSnapshot().actions.find(action => action.state === 'walk').time;
const lateWalkPhase = (lateWalkTime / (rifleWalk.duration / 3)) % 1;
lateWalkController.setMovementSpeedScale(1.2);
assert.ok(Math.abs(lateWalkController.getSnapshot().actions.find(action => action.state === 'jog').time
  / rifleJog.duration - lateWalkPhase) < 1e-6, 'Walk to Jog lost phase after multiple Walk cycles');
lateWalkController.dispose();
runController.update(0.12);
runReference.update(0.12);
runRoot.updateMatrixWorld(true);
const beforeRunShot = runRoot.getObjectByName('mixamorigRightArm').matrixWorld.clone();
assert.ok(runController.playOneShot('shoot'), 'Running Shoot did not start');
assert.equal(runController.getSnapshot().actions.find(action => action.state === 'shoot').name,
  'RifleRunShoot', 'Running must choose the phase-matched recoil action');
const runShotClip = runController.lastShootAction.getClip();
for (const name of ['mixamorigSpine', 'mixamorigLeftArm', 'mixamorigRightArm']) {
  const track = runShotClip.tracks.find(candidate => candidate.name === `${name}.quaternion`);
  const firstPose = new THREE.Quaternion().fromArray(track.values, 0);
  const liveRunPose = runReferenceRoot.getObjectByName(name).quaternion;
  assert.ok(firstPose.angleTo(liveRunPose) < 5e-4,
    `RifleRunShoot starts out of phase with the current Run pose: ${name}, angle=${firstPose.angleTo(liveRunPose)}`);
}
runRoot.updateMatrixWorld(true);
assert.ok(beforeRunShot.elements.every((value, index) =>
  Math.abs(value - runRoot.getObjectByName('mixamorigRightArm').matrixWorld.elements[index]) < 1e-6),
  'Starting RifleRunShoot jumps before the first update');
runController.update(0.1);
runReference.update(0.1);
runRoot.updateMatrixWorld(true);
runReferenceRoot.updateMatrixWorld(true);
const runRecoilHandMotion = runRoot.getObjectByName('mixamorigRightHand').getWorldPosition(new THREE.Vector3())
  .distanceTo(runReferenceRoot.getObjectByName('mixamorigRightHand').getWorldPosition(new THREE.Vector3()));
const runRecoilArmAngle = THREE.MathUtils.radToDeg(runRoot.getObjectByName('mixamorigRightArm')
  .getWorldQuaternion(new THREE.Quaternion()).angleTo(runReferenceRoot.getObjectByName('mixamorigRightArm')
    .getWorldQuaternion(new THREE.Quaternion())));
assert.ok(runRecoilHandMotion > 0.025 && runRecoilArmAngle > 7,
  `RifleRunShoot recoil is too faint: ${runRecoilHandMotion} units, ${runRecoilArmAngle}°`);
let runLowerBodyError = 0;
for (const name of ['mixamorigHips', 'mixamorigLeftUpLeg', 'mixamorigRightUpLeg',
  'mixamorigLeftLeg', 'mixamorigRightLeg', 'mixamorigLeftFoot', 'mixamorigRightFoot']) {
  const current = runRoot.getObjectByName(name).matrixWorld.elements;
  const reference = runReferenceRoot.getObjectByName(name).matrixWorld.elements;
  current.forEach((value, index) => {
    runLowerBodyError = Math.max(runLowerBodyError, Math.abs(value - reference[index]));
  });
}
assert.ok(runLowerBodyError < 1e-6, `RifleRunShoot overrides the running legs: ${runLowerBodyError}`);
runController.update(0.21);
runReference.update(0.21);
assert.equal(runController.getSnapshot().state, 'run', 'Running Shoot did not return to Run');
runController.update(0.12);
runReference.update(0.12);
runRoot.updateMatrixWorld(true);
runReferenceRoot.updateMatrixWorld(true);
let returnedRunArmError = 0;
for (const name of ['mixamorigLeftArm', 'mixamorigRightArm']) {
  const actual = runRoot.getObjectByName(name).matrixWorld.elements;
  const expected = runReferenceRoot.getObjectByName(name).matrixWorld.elements;
  actual.forEach((value, index) => {
    returnedRunArmError = Math.max(returnedRunArmError, Math.abs(value - expected[index]));
  });
}
assert.ok(returnedRunArmError < 1e-5,
  `RifleRunShoot does not return to the current Run phase: ${returnedRunArmError}`);
let runSkin;
runRoot.traverse(object => { if (object.isSkinnedMesh) runSkin = object; });
const runForearmIndex = runSkin.skeleton.bones.findIndex(bone => bone.name.endsWith('LeftForeArm'));
const runHandIndex = runSkin.skeleton.bones.findIndex(bone => bone.name.endsWith('LeftHand'));
const runDeformationRotation = index => new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().extractRotation(runSkin.skeleton.bones[index].matrixWorld.clone()
    .multiply(runSkin.skeleton.boneInverses[index])),
).normalize();
let rapidRunShotCount = 0;
let maxImmediateRunShotJump = 0;
let maxRunShootWristAngle = 0;
for (let frame = 0; frame < 60; frame++) {
  if (frame % 12 === 0) {
    runRoot.updateMatrixWorld(true);
    const before = runRoot.getObjectByName('mixamorigRightArm').matrixWorld.clone();
    assert.ok(runController.playOneShot('shoot'), 'Rapid running shot did not start');
    const firstArmTrack = runController.lastShootAction.getClip().tracks.find(
      track => track.name === 'mixamorigRightArm.quaternion');
    const phaseError = new THREE.Quaternion().fromArray(firstArmTrack.values, 0)
      .angleTo(runReferenceRoot.getObjectByName('mixamorigRightArm').quaternion);
    assert.ok(phaseError < 0.002,
      `Rapid running shot lost the current Run phase: ${phaseError}, layered=${runController.getSnapshot().actions.find(action => action.state === 'run').time}, reference=${runReference.getSnapshot().actions.find(action => action.state === 'run').time}`);
    runRoot.updateMatrixWorld(true);
    const after = runRoot.getObjectByName('mixamorigRightArm').matrixWorld;
    before.elements.forEach((value, index) => {
      maxImmediateRunShotJump = Math.max(maxImmediateRunShotJump, Math.abs(value - after.elements[index]));
    });
    assert.equal(runController.getSnapshot().actions.find(action => action.state === 'shoot').name,
      'RifleRunShoot', 'Rapid running shot switched to the walking pose');
    rapidRunShotCount++;
  }
  runController.update(1 / 60);
  runReference.update(1 / 60);
  runRoot.updateMatrixWorld(true);
  maxRunShootWristAngle = Math.max(maxRunShootWristAngle, THREE.MathUtils.radToDeg(
    runDeformationRotation(runForearmIndex).angleTo(runDeformationRotation(runHandIndex))));
  assert.ok(Math.abs(runController.getSnapshot().actions.reduce((sum, action) => sum + action.weight, 0) - 1) < 1e-6,
    'Running recoil weights do not sum to one');
}
assert.equal(rapidRunShotCount, 5);
assert.ok(maxImmediateRunShotJump < 1e-6,
  `Rapid running shots snap at trigger time: ${maxImmediateRunShotJump}`);
assert.ok(maxRunShootWristAngle < 90,
  `RifleRunShoot pinches the left wrist: ${maxRunShootWristAngle}°`);
runController.update(0.4);
runReference.update(0.4);
assert.equal(runController.getSnapshot().state, 'run', 'Rapid running fire did not return to Run');
assert.ok(runController.playOneShot('reload', { durationSeconds: 1.3 }), 'Running Reload did not start');
runController.update(1.3);
assert.equal(runController.getSnapshot().state, 'run', 'Running Reload did not return to Run');
runController.setMovementSpeedScale(1.2);
assert.equal(runController.getSnapshot().state, 'jog', 'Reducing speed from Run should enter Jog');
assert.ok(runController.playOneShot('shoot'), 'Jogging Shoot did not start');
assert.equal(runController.getSnapshot().actions.find(action => action.state === 'shoot').name,
  'Shoot', 'Jogging should use the Walk Shoot upper-body action');
runController.update(0.31);
assert.equal(runController.getSnapshot().state, 'jog', 'Jogging Shoot did not return to Jog');
runController.setMovementSpeedScale(1.5);
assert.ok(runController.playOneShot('shoot'), 'Running Shoot did not restart after Reload');
runController.setMovement(0, 0);
runController.update(0.31);
assert.equal(runController.getSnapshot().state, 'idle', 'RifleRunShoot did not return to Idle after stopping');
runController.setMovementSpeedScale(1);
runController.setMovement(1, 0);
assert.equal(runController.getSnapshot().state, 'walk', 'Slowing down did not return to Walk');
runController.dispose();
runReference.dispose();
console.log(JSON.stringify({ test: 'runtime armed run', duration: rifleRun.duration, walkFootMinimum, runFootMinimum,
  originalWalkGait, rifleWalkGait, rifleJogGait,
  runRecoilHandMotion, runRecoilArmAngle, runLowerBodyError, returnedRunArmError,
  rapidRunShotCount, maxImmediateRunShotJump, maxRunShootWristAngle,
  gaitPhasePreserved: true, shootFallback: true, reloadFallback: true }));
const root = clone(asset.scene);
const controller = new CharacterAnimationController(root, asset.animations, { clips: { idle: /^idle$/i, walk: /^walk$/i, shoot: /^shoot$/i } });
const bones = [];
root.traverse(object => { if (object.isBone) bones.push(object); });
assert.equal(bones.length, 65);
const matrices = () => { root.updateMatrixWorld(true); return bones.map(bone => bone.matrixWorld.toArray()); };
let zeroTimePoseError = 0;
for (let frame = 0; frame < 1200; frame++) {
  // Repeated ordinary transitions followed by rapid interruptions at 120 Hz.
  const moving = frame < 600 ? Math.floor(frame / 120) % 2 : Math.floor(frame / 3) % 2;
  const before = matrices();
  controller.setMovement(moving, 0);
  matrices().forEach((matrix, index) => matrix.forEach((value, component) => {
    zeroTimePoseError = Math.max(zeroTimePoseError, Math.abs(value - before[index][component]));
    assert.ok(Number.isFinite(value));
  }));
  assert.ok(zeroTimePoseError < 1e-6, `Pose jumps when reversing: ${zeroTimePoseError}`);
  controller.update(1 / 120);
  const weights = controller.getSnapshot().actions.reduce((sum, action) => sum + action.weight, 0);
  assert.ok(Math.abs(weights - 1) < 1e-9);
}
controller.setMovement(0, 0); controller.update(0.2);
assert.equal(controller.getSnapshot().actions.find(action => action.state === 'idle').weight, 1);
const runtimeShoot = asset.animations.find(clip => clip.name === 'Shoot');
assert.ok(runtimeShoot, 'Missing Shoot clip');
assert.ok(controller.playOneShot('shoot'));
controller.update(0.08);
assert.equal(controller.getSnapshot().actions.find(action => action.state === 'shoot').weight, 1);
controller.setMovement(1, 0);
controller.update(runtimeShoot.duration);
assert.equal(controller.getSnapshot().state, 'walk');
controller.update(0.12);
assert.equal(controller.getSnapshot().actions.find(action => action.state === 'walk').weight, 1);
controller.setMovement(0, 0); controller.update(0.12);
let shootStarts = 0, maxShootTime = 0, zeroTimeShootError = 0;
for (let frame = 0; frame < 270; frame++) {
  // The actual SMG fires five rounds per second; the 1.33-second Shoot clip
  // must advance to its end instead of restarting on every round.
  if (frame % 12 === 0) {
    const before = matrices();
    if (controller.playOneShot('shoot', { restartIfActive: false })) shootStarts++;
    matrices().forEach((matrix, index) => matrix.forEach((value, component) => {
      zeroTimeShootError = Math.max(zeroTimeShootError, Math.abs(value - before[index][component]));
    }));
    assert.ok(zeroTimeShootError < 1e-6, `Shoot pose jumps when starting or skipping a round: ${zeroTimeShootError}`);
  }
  controller.update(1 / 60);
  const snapshot = controller.getSnapshot();
  maxShootTime = Math.max(maxShootTime, snapshot.actions.find(action => action.state === 'shoot').time);
  assert.ok(Math.abs(snapshot.actions.reduce((sum, action) => sum + action.weight, 0) - 1) < 1e-9);
}
assert.ok(shootStarts >= 3 && shootStarts <= 4, `Unexpected Shoot start count during SMG fire: ${shootStarts}`);
assert.ok(maxShootTime > runtimeShoot.duration * 0.9, 'Shoot does not progress through its full clip');
assert.ok(controller.stopOneShot('shoot'), 'Reload should stop the active Shoot clip');
controller.update(0.12);
assert.equal(controller.getSnapshot().state, 'idle');
assert.equal(controller.getSnapshot().actions.find(action => action.state === 'idle').weight, 1);

// Shooting must leave the actual player's hips and legs on the Walk/Idle pose.
const layeredRoot = clone(asset.scene), locomotionRoot = clone(asset.scene);
const layered = new CharacterAnimationController(layeredRoot, asset.animations, {
  clips: armedClips, shootUpperBodyOnly: true,
  shootPulseEndSeconds: 0.3,
});
const locomotion = new CharacterAnimationController(locomotionRoot, asset.animations, {
  clips: { idle: armedClips.idle, walk: armedClips.walk },
});
const upperBoneNames = new Set();
layeredRoot.getObjectByName('mixamorigSpine').traverse(object => {
  if (object.isBone) upperBoneNames.add(object.name);
});
const lowerBoneNames = bones.map(bone => bone.name).filter(name => !upperBoneNames.has(name));
const compareLowerBody = () => {
  layeredRoot.updateMatrixWorld(true); locomotionRoot.updateMatrixWorld(true);
  let error = 0;
  for (const name of lowerBoneNames) {
    const actual = layeredRoot.getObjectByName(name).matrixWorld.elements;
    const expected = locomotionRoot.getObjectByName(name).matrixWorld.elements;
    for (let index = 0; index < 16; index++) error = Math.max(error, Math.abs(actual[index] - expected[index]));
  }
  assert.ok(error < 1e-6, `Shoot overrides the locomotion legs: ${error}`);
  return error;
};
layered.setMovement(1, 0); locomotion.setMovement(1, 0);
layered.update(0.25); locomotion.update(0.25);
assert.ok(layered.playOneShot('shoot'));
const singlePulseDuration = layered.getSnapshot().actions.find(action => action.state === 'shoot').duration;
assert.ok(singlePulseDuration > 0.29 && singlePulseDuration < 0.31,
  `Single shot must stop before the source clip's second recoil: ${singlePulseDuration}`);
layered.update(0.12); locomotion.update(0.12);
let lowerBodyPoseError = compareLowerBody();
assert.ok(layered.getSnapshot().actions.find(action => action.state === 'shoot').weight > 0.99);
const shootSpine = layeredRoot.getObjectByName('mixamorigSpine');
const walkSpine = locomotionRoot.getObjectByName('mixamorigSpine');
assert.ok(shootSpine.quaternion.angleTo(walkSpine.quaternion) > 0.05, 'Shoot does not animate the upper body');
layered.setMovement(0, 0); locomotion.setMovement(0, 0);
layered.update(0.1); locomotion.update(0.1);
lowerBodyPoseError = Math.max(lowerBodyPoseError, compareLowerBody());
assert.equal(layered.getSnapshot().state, 'shoot', 'Changing locomotion should not interrupt Shoot');
layered.update(0.1); locomotion.update(0.1);
assert.equal(layered.getSnapshot().state, 'idle');
// The upper Walk may restart at frame zero after Shoot while the leg Walk
// continues. That puts the same-side arm and leg forward together.
layered.setMovement(1, 0); locomotion.setMovement(1, 0);
layered.update(0.31); locomotion.update(0.31);
assert.ok(layered.playOneShot('shoot'));
layered.update(0.45); locomotion.update(0.45);
layered.update(0.15); locomotion.update(0.15);
assert.equal(layered.getSnapshot().state, 'walk');
const upperWalkTime = layered.getSnapshot().actions.find(action => action.state === 'walk').time;
const legWalkTime = locomotion.getSnapshot().actions.find(action => action.state === 'walk').time;
assert.ok(Math.abs(upperWalkTime - legWalkTime) < 1e-6,
  `Upper Walk phase ${upperWalkTime} differs from leg Walk phase ${legWalkTime}`);
layeredRoot.updateMatrixWorld(true); locomotionRoot.updateMatrixWorld(true);
let returnedArmPoseError = 0;
for (const name of ['mixamorigLeftArm', 'mixamorigRightArm']) {
  const actual = layeredRoot.getObjectByName(name).matrixWorld.elements;
  const expected = locomotionRoot.getObjectByName(name).matrixWorld.elements;
  for (let index = 0; index < 16; index++) {
    returnedArmPoseError = Math.max(returnedArmPoseError, Math.abs(actual[index] - expected[index]));
  }
}
assert.ok(returnedArmPoseError < 1e-5, `Arms are out of phase after Shoot: ${returnedArmPoseError}`);

// Five shots per second should each begin one short recoil. Alternating
// actions blend the old and new pulse without a zero-time pose jump.
let rapidShotPoseError = 0, rapidShotCount = 0;
for (let frame = 0; frame < 60; frame++) {
  if (frame % 12 === 0) {
    layeredRoot.updateMatrixWorld(true);
    const before = layeredRoot.getObjectByName('mixamorigRightArm').matrixWorld.clone();
    assert.ok(layered.playOneShot('shoot'), `Shot ${rapidShotCount + 1} did not restart its recoil`);
    rapidShotCount++;
    layeredRoot.updateMatrixWorld(true);
    const after = layeredRoot.getObjectByName('mixamorigRightArm').matrixWorld;
    before.elements.forEach((value, index) => {
      rapidShotPoseError = Math.max(rapidShotPoseError, Math.abs(value - after.elements[index]));
    });
    assert.ok(rapidShotPoseError < 1e-6, `Rapid-fire recoil snaps at frame ${frame}: ${rapidShotPoseError}`);
  }
  layered.update(1 / 60); locomotion.update(1 / 60);
  lowerBodyPoseError = Math.max(lowerBodyPoseError, compareLowerBody());
  const weight = layered.getSnapshot().actions.reduce((sum, action) => sum + action.weight, 0);
  assert.ok(Math.abs(weight - 1) < 1e-6, `Rapid-fire weights do not add to one: ${weight}`);
}
assert.equal(rapidShotCount, 5);
layered.update(0.42); locomotion.update(0.42);
assert.equal(layered.getSnapshot().state, 'walk');
layered.update(0.12); locomotion.update(0.12);
assert.ok(layered.getSnapshot().actions.find(action => action.state === 'shoot').weight < 1e-6,
  'Single-shot recoil should release the upper body after the last bullet');
layeredRoot.updateMatrixWorld(true); locomotionRoot.updateMatrixWorld(true);
for (const name of ['mixamorigLeftArm', 'mixamorigRightArm']) {
  const actual = layeredRoot.getObjectByName(name).matrixWorld.elements;
  const expected = locomotionRoot.getObjectByName(name).matrixWorld.elements;
  for (let index = 0; index < 16; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) < 1e-5,
      `${name} remains out of phase after rapid fire`);
  }
}
layered.dispose(); locomotion.dispose();

// The long Mixamo Reload must finish in the weapon's 1.3-second window while
// the legs continue their armed Walk, then return to that same Walk phase.
const reloadLayerRoot = clone(asset.scene), reloadLegRoot = clone(asset.scene);
const reloadLayer = new CharacterAnimationController(reloadLayerRoot, asset.animations, {
  clips: armedClips, shootUpperBodyOnly: true, shootPulseEndSeconds: 0.3,
});
const reloadLegs = new CharacterAnimationController(reloadLegRoot, asset.animations, {
  clips: { idle: armedClips.idle, walk: armedClips.walk },
});
reloadLayer.setMovement(1, 0); reloadLegs.setMovement(1, 0);
reloadLayer.update(0.2); reloadLegs.update(0.2);
assert.ok(reloadLayer.playOneShot('reload', { durationSeconds: 1.3 }));
reloadLayer.update(0.65); reloadLegs.update(0.65);
const halfwayReload = reloadLayer.getSnapshot().actions.find(action => action.state === 'reload');
assert.ok(halfwayReload.time > 1.64 && halfwayReload.time < 1.66,
  `Reload did not follow gameplay duration: ${halfwayReload.time}`);
reloadLayerRoot.updateMatrixWorld(true); reloadLegRoot.updateMatrixWorld(true);
let reloadLegError = 0;
for (const name of lowerBoneNames) {
  const actual = reloadLayerRoot.getObjectByName(name).matrixWorld.elements;
  const expected = reloadLegRoot.getObjectByName(name).matrixWorld.elements;
  for (let index = 0; index < 16; index++) reloadLegError = Math.max(reloadLegError, Math.abs(actual[index] - expected[index]));
}
assert.ok(reloadLegError < 1e-6, `Reload overrides the Walk legs: ${reloadLegError}`);
reloadLayer.update(0.65); reloadLegs.update(0.65);
assert.equal(reloadLayer.getSnapshot().state, 'walk', 'Reload did not return to the moving pose');
reloadLayer.update(0.12); reloadLegs.update(0.12);
assert.ok(reloadLayer.getSnapshot().actions.find(action => action.state === 'reload').weight < 1e-6);
reloadLayer.dispose(); reloadLegs.dispose();

// Exercise the game wrapper as well, including normalization and skin cloning.
const config = { url: 'test-player', height: 118, shootUpperBodyOnly: true, shootPulseEndSeconds: 0.3,
  jogFromWalkRun: true, runShootFromRun: true, heldWeapon: 'smg', clips: armedClips };
const player = new AnimatedCharacter(asset, config);
const other = new AnimatedCharacter(asset, config);
const reloadPlayer = new AnimatedCharacter(asset, config);
const runningPlayer = new AnimatedCharacter(asset, config);
const runningReferencePlayer = new AnimatedCharacter(asset, config);
for (const character of [runningPlayer, runningReferencePlayer]) {
  character.setMovement(1, 0);
  character.setMovementSpeedScale(1.5);
  character.update(0.2);
}
assert.ok(runningPlayer.playOneShot('shoot'));
runningPlayer.update(0.1);
runningReferencePlayer.update(0.1);
assert.equal(runningPlayer.animation.getSnapshot().actions.find(action => action.state === 'shoot').name,
  'RifleRunShoot');
const runningMuzzle = runningPlayer.muzzleSocket.getWorldPosition(new THREE.Vector3());
const referenceMuzzle = runningReferencePlayer.muzzleSocket.getWorldPosition(new THREE.Vector3());
const runningMuzzleKick = runningMuzzle.distanceTo(referenceMuzzle);
assert.ok(runningMuzzleKick > 2.5, `Running gun has no visible recoil: ${runningMuzzleKick}`);
const runningBarrel = new THREE.Vector3(0, 0, 1).applyQuaternion(
  runningPlayer.muzzleSocket.getWorldQuaternion(new THREE.Quaternion()));
assert.ok(Math.abs(runningBarrel.y) < 1e-4 && runningBarrel.z > 0.999,
  `Running recoil tilts the barrel away from aim: ${runningBarrel.toArray()}`);
const runningPalm = runningPlayer.root.getObjectByName('mixamorigLeftHand').getWorldPosition(new THREE.Vector3())
  .lerp(runningPlayer.root.getObjectByName('mixamorigLeftHandMiddle1').getWorldPosition(new THREE.Vector3()), 0.5);
const runningHandguard = runningPlayer.root.getObjectByName('handguard');
const runningPalmGap = new THREE.Box3().setFromObject(runningHandguard).distanceToPoint(runningPalm);
assert.ok(runningPalmGap < 3, `Running recoil loses the left-hand grip: ${runningPalmGap}`);
const unarmedPlayer = new AnimatedCharacter(asset, {
  ...config,
  jogFromWalkRun: false,
  runShootFromRun: false,
  clips: { idle: /^Idle$/i, walk: /^Walk$/i, shoot: /^Shoot$/i, reload: /^Reload$/i },
});
const unarmedGun = unarmedPlayer.root.getObjectByName('heldSmg');
assert.ok(unarmedGun && !unarmedGun.visible, 'Original Idle still shows the gun');
unarmedPlayer.setMovement(1, 0);
unarmedPlayer.update(0.2);
assert.ok(!unarmedGun.visible, 'Original Walk still shows the gun');
assert.ok(unarmedPlayer.playOneShot('shoot'));
unarmedPlayer.update(0.1);
assert.ok(unarmedGun.visible, 'Shoot does not reveal the gun');
unarmedPlayer.update(0.4);
unarmedPlayer.update(0.12);
assert.ok(!unarmedGun.visible, 'Gun remains visible after Shoot returns to original Walk');
assert.ok(unarmedPlayer.playOneShot('reload', { durationSeconds: 1.3 }));
unarmedPlayer.update(0.2);
assert.ok(unarmedGun.visible, 'Reload does not reveal the gun');
unarmedPlayer.update(1.3);
unarmedPlayer.update(0.12);
assert.ok(!unarmedGun.visible, 'Gun remains visible after Reload returns to original Walk');
const fixedMagazine = reloadPlayer.root.getObjectByName('magazine');
const movingMagazine = reloadPlayer.root.getObjectByName('movingMagazine');
const reloadGun = reloadPlayer.root.getObjectByName('heldSmg');
const reloadMuzzle = reloadPlayer.muzzleSocket;
const reloadHand = reloadPlayer.root.getObjectByName('mixamorigRightHand');
const indexBase = reloadPlayer.root.getObjectByName('mixamorigRightHandIndex1');
const indexNext = reloadPlayer.root.getObjectByName('mixamorigRightHandIndex2');
const fingerDirection = () => indexNext.getWorldPosition(new THREE.Vector3())
  .sub(indexBase.getWorldPosition(new THREE.Vector3())).normalize();
const reloadMuzzleDirection = () => new THREE.Vector3(0, 0, 1).applyQuaternion(
  reloadMuzzle.getWorldQuaternion(new THREE.Quaternion()));
const expectedReloadDirection = finger => finger.clone().setY(finger.y * 0.25).normalize();
assert.ok(fixedMagazine && movingMagazine && fixedMagazine.visible && !movingMagazine.visible);
assert.ok(reloadPlayer.playOneShot('reload', { durationSeconds: 1.3 }));
reloadPlayer.update(1 / 60);
reloadPlayer.update(0.25 - 1 / 60);
assert.ok(!fixedMagazine.visible && movingMagazine.visible, 'Magazine does not leave the gun during Reload');
const earlyReloadDirection = reloadMuzzleDirection();
const earlyFingerDirection = fingerDirection();
assert.ok(earlyReloadDirection.angleTo(expectedReloadDirection(earlyFingerDirection)) < 1e-4,
  'Reload barrel does not follow the right index heading');
assert.ok(earlyReloadDirection.y > -0.05,
  'Reload barrel still points below the right hand');
assert.ok(reloadGun.getWorldPosition(new THREE.Vector3()).distanceTo(
  reloadHand.getWorldPosition(new THREE.Vector3())) < 1e-4,
  'Reload gun grip no longer follows the right palm');
reloadPlayer.update(0.7);
assert.ok(fixedMagazine.visible && !movingMagazine.visible, 'Magazine does not return before Reload ends');
const laterReloadDirection = reloadMuzzleDirection();
const laterFingerDirection = fingerDirection();
assert.ok(earlyFingerDirection.angleTo(laterFingerDirection) > 0.2,
  'Reload source finger did not change direction at the sampled poses');
assert.ok(earlyReloadDirection.angleTo(laterReloadDirection) > 0.15,
  `Reload gun muzzle is still locked to a fixed direction: ${earlyReloadDirection.toArray()} -> ${laterReloadDirection.toArray()}, angle ${earlyReloadDirection.angleTo(laterReloadDirection)}`);
assert.ok(laterReloadDirection.angleTo(expectedReloadDirection(laterFingerDirection)) < 1e-4,
  'Reload barrel drifts away from the right index heading later in the animation');
assert.ok(laterReloadDirection.y > -0.05,
  'Reload barrel points below the right hand later in the animation');
assert.ok(reloadGun.getWorldPosition(new THREE.Vector3()).distanceTo(
  reloadHand.getWorldPosition(new THREE.Vector3())) < 1e-4,
  'Reload gun grip detached from the right palm later in the animation');
reloadPlayer.update(0.35);
assert.ok(fixedMagazine.visible && !movingMagazine.visible, 'Reload leaves an extra visible magazine');
const reloadSweep = new AnimatedCharacter(asset, config);
assert.ok(reloadSweep.playOneShot('reload', { durationSeconds: 1.3 }));
let minReloadMuzzleY = Infinity, maxReloadMuzzleY = -Infinity, maxReloadHeadingError = 0;
const sweepGun = reloadSweep.root.getObjectByName('heldSmg');
const sweepHand = reloadSweep.root.getObjectByName('mixamorigRightHand');
const sweepIndexBase = reloadSweep.root.getObjectByName('mixamorigRightHandIndex1');
const sweepIndexNext = reloadSweep.root.getObjectByName('mixamorigRightHandIndex2');
for (let frame = 0; frame < 78; frame++) {
  reloadSweep.update(1 / 60);
  const muzzle = new THREE.Vector3(0, 0, 1).applyQuaternion(
    reloadSweep.muzzleSocket.getWorldQuaternion(new THREE.Quaternion()));
  if (frame >= 5 && frame < 77) {
    const finger = sweepIndexNext.getWorldPosition(new THREE.Vector3()).sub(
      sweepIndexBase.getWorldPosition(new THREE.Vector3())).normalize();
    minReloadMuzzleY = Math.min(minReloadMuzzleY, muzzle.y);
    maxReloadMuzzleY = Math.max(maxReloadMuzzleY, muzzle.y);
    maxReloadHeadingError = Math.max(maxReloadHeadingError, muzzle.angleTo(expectedReloadDirection(finger)));
  }
  assert.ok(sweepGun.getWorldPosition(new THREE.Vector3()).distanceTo(
    sweepHand.getWorldPosition(new THREE.Vector3())) < 1e-4,
    'Reload gun grip detached from the right palm during playback');
}
assert.ok(maxReloadHeadingError < 1e-4, `Reload heading drifts during playback: ${maxReloadHeadingError}`);
assert.ok(minReloadMuzzleY > -0.1, `Reload muzzle still points down: ${minReloadMuzzleY}`);
assert.ok(maxReloadMuzzleY < 0.35, `Reload muzzle lifts too steeply: ${maxReloadMuzzleY}`);
reloadSweep.dispose();
const rightHand = player.root.getObjectByName('mixamorigRightHand');
const weapon = player.root.getObjectByName('heldSmg');
assert.ok(rightHand?.isBone && weapon && player.muzzleSocket, 'Player gun or muzzle socket is missing');
assert.ok(weapon.visible, 'Armed RifleIdle incorrectly hides the gun');
player.setMovement(1, 0);
player.update(0.2);
assert.ok(weapon.visible, 'Armed RifleWalk incorrectly hides the gun');
const walkPalm = player.root.getObjectByName('mixamorigLeftHand').getWorldPosition(new THREE.Vector3())
  .lerp(player.root.getObjectByName('mixamorigLeftHandMiddle1').getWorldPosition(new THREE.Vector3()), 0.5);
const walkPalmGap = new THREE.Box3().setFromObject(player.root.getObjectByName('handguard'))
  .distanceToPoint(walkPalm);
player.setMovementSpeedScale(1.2);
player.update(0.2);
assert.equal(player.animation.getSnapshot().state, 'jog', 'Player did not select RifleJog at medium acceleration');
const joggingPalm = player.root.getObjectByName('mixamorigLeftHand').getWorldPosition(new THREE.Vector3())
  .lerp(player.root.getObjectByName('mixamorigLeftHandMiddle1').getWorldPosition(new THREE.Vector3()), 0.5);
const joggingPalmGap = new THREE.Box3().setFromObject(player.root.getObjectByName('handguard'))
  .distanceToPoint(joggingPalm);
assert.ok(joggingPalmGap <= walkPalmGap + 2,
  `RifleJog worsens the existing RifleWalk left-hand grip: walk=${walkPalmGap}, jog=${joggingPalmGap}`);
assert.ok(weapon.visible, 'Armed RifleJog incorrectly hides the gun');
player.setMovementSpeedScale(1.5);
player.update(0.2);
assert.equal(player.animation.getSnapshot().state, 'run', 'Player did not select RifleRun at full acceleration');
assert.ok(weapon.visible, 'Armed RifleRun incorrectly hides the gun');
const runForward = new THREE.Vector3(0, 0, 1).applyQuaternion(
  player.muzzleSocket.getWorldQuaternion(new THREE.Quaternion()));
assert.ok(Math.abs(runForward.y) < 1e-4 && runForward.z > 0.999,
  `RifleRun barrel is not level: ${runForward.toArray()}`);
player.setMovementSpeedScale(1);
player.setMovement(0, 0);
player.update(0.2);
assert.ok(rightHand.getObjectByName('weaponSocket')?.getObjectByName('heldSmg') === weapon,
  'The gun must follow the right-hand bone');
assert.notEqual(player.muzzleSocket, other.muzzleSocket, 'Muzzle sockets are shared between characters');
const muzzleForward = () => new THREE.Vector3(0, 0, 1).applyQuaternion(
  player.muzzleSocket.getWorldQuaternion(new THREE.Quaternion()));
const neutralDirection = muzzleForward();
assert.ok(neutralDirection.z > 0.75 && neutralDirection.y < -0.25,
  `Idle gun should be lowered forward, not at the feet: ${neutralDirection.toArray()}`);
const runSweep = new AnimatedCharacter(asset, config);
runSweep.setMovement(1, 0);
runSweep.setMovementSpeedScale(1.5);
runSweep.update(0.06);
const blendedRunForward = new THREE.Vector3(0, 0, 1).applyQuaternion(
  runSweep.muzzleSocket.getWorldQuaternion(new THREE.Quaternion()));
assert.ok(blendedRunForward.y < -0.1 && blendedRunForward.y > -0.35,
  `Idle to Run does not raise the barrel gradually: ${blendedRunForward.toArray()}`);
runSweep.update(0.06);
let maxRunMuzzleY = 0;
let maxRunPalmToHandguard = 0;
const runLeftHand = runSweep.root.getObjectByName('mixamorigLeftHand');
const runLeftMiddle = runSweep.root.getObjectByName('mixamorigLeftHandMiddle1');
const runGun = runSweep.root.getObjectByName('heldSmg');
const runHandguard = runGun.getObjectByName('handguard');
for (let frame = 0; frame < 60; frame++) {
  runSweep.update(1 / 60);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(
    runSweep.muzzleSocket.getWorldQuaternion(new THREE.Quaternion()));
  maxRunMuzzleY = Math.max(maxRunMuzzleY, Math.abs(forward.y));
  assert.ok(forward.z > 0.999, `RifleRun barrel turns away from travel: ${forward.toArray()}`);
  const palm = runLeftHand.getWorldPosition(new THREE.Vector3())
    .lerp(runLeftMiddle.getWorldPosition(new THREE.Vector3()), 0.5);
  maxRunPalmToHandguard = Math.max(maxRunPalmToHandguard,
    new THREE.Box3().setFromObject(runHandguard).distanceToPoint(palm));
}
assert.ok(maxRunMuzzleY < 1e-4, `RifleRun barrel tilts during its cycle: ${maxRunMuzzleY}`);
assert.ok(maxRunPalmToHandguard < 3,
  `RifleRun left hand floats away from the handguard: ${maxRunPalmToHandguard}`);
runSweep.root.rotation.y = Math.PI / 2;
runSweep.update(0);
const turnedRunForward = new THREE.Vector3(0, 0, 1).applyQuaternion(
  runSweep.muzzleSocket.getWorldQuaternion(new THREE.Quaternion()));
assert.ok(turnedRunForward.x > 0.999 && Math.abs(turnedRunForward.y) < 1e-4,
  `Turning while running tilts the barrel: ${turnedRunForward.toArray()}`);
runSweep.dispose();
const muzzleBeforeShoot = player.muzzleSocket.getWorldPosition(new THREE.Vector3());
assert.ok(player.playOneShot('shoot'));
player.update(0.1);
const muzzleDuringShoot = player.muzzleSocket.getWorldPosition(new THREE.Vector3());
assert.ok(muzzleDuringShoot.distanceTo(muzzleBeforeShoot) > 1,
  'The muzzle socket does not move with the Shoot pose');
const aimedDirection = muzzleForward();
assert.ok(aimedDirection.z > 0.999 && Math.abs(aimedDirection.x) < 1e-3 && Math.abs(aimedDirection.y) < 1e-3,
  `Shoot gun barrel is not level with the aim line: ${aimedDirection.toArray()}`);
for (const yaw of [Math.PI / 2, Math.PI, -Math.PI / 2]) {
  player.root.rotation.y = yaw;
  player.update(0);
  const direction = muzzleForward();
  assert.ok(Math.abs(direction.x - Math.sin(yaw)) < 1e-3
    && Math.abs(direction.y) < 1e-3
    && Math.abs(direction.z - Math.cos(yaw)) < 1e-3,
  `Shoot barrel diverges when facing ${yaw}: ${direction.toArray()}`);
}
player.root.rotation.y = 0;
player.update(0);
const leftWrist = player.root.getObjectByName('mixamorigLeftHand');
const leftMiddleBase = player.root.getObjectByName('mixamorigLeftHandMiddle1');
const supportSocket = weapon.getObjectByName('supportHandSocket');
assert.ok(leftWrist?.isBone && leftMiddleBase?.isBone && supportSocket,
  'The left-hand support attachment is missing');
for (const delta of [0, 0.1, 0.1]) {
  player.update(delta);
  const palm = leftWrist.getWorldPosition(new THREE.Vector3())
    .lerp(leftMiddleBase.getWorldPosition(new THREE.Vector3()), 0.5);
  const support = supportSocket.getWorldPosition(new THREE.Vector3());
  assert.ok(palm.distanceTo(support) < 5,
    `Left palm floats away from the gun during Shoot: ${palm.distanceTo(support)}`);
}
const bounds = new THREE.Box3().setFromObject(player.root);
assert.ok(bounds.getSize(new THREE.Vector3()).y >= 118 - 1e-4);
assert.ok(Math.abs(bounds.min.y) < 1e-4);
const otherBone = other.root.getObjectByName(bones[0].name);
other.root.updateMatrixWorld(true);
const otherPose = otherBone.matrixWorld.clone();
for (let frame = 0; frame < 180; frame++) { player.setMovement(frame % 10 < 5 ? 1 : 0, 0); player.update(1 / 60); }
other.root.updateMatrixWorld(true);
assert.ok(otherBone.matrixWorld.equals(otherPose), 'Game instances share mutable bone state');
player.dispose(); other.dispose(); reloadPlayer.dispose(); runningPlayer.dispose(); runningReferencePlayer.dispose(); unarmedPlayer.dispose(); controller.dispose();
console.log(JSON.stringify({ test: 'runtime player transitions', bones: bones.length, frames: 1200, zeroTimePoseError, zeroTimeShootError, lowerBodyPoseError, returnedArmPoseError, rapidShotPoseError, rapidShotCount, singlePulseDuration, maxRunMuzzleY, maxRunPalmToHandguard, runningMuzzleKick, runningPalmGap, height: 118, grounded: true, independent: true, shootFallback: true, shootStarts, maxShootTime }));

// A 140-degree wrist deformation pinched the Shoot mesh. Guard against its
// return in the compressed runtime asset, including interpolated half-frames.
const shoot = asset.animations.find(clip => clip.name === 'Shoot');
assert.ok(shoot, 'Missing Shoot clip');
const shootRoot = clone(asset.scene);
let skin;
shootRoot.traverse(object => { if (object.isSkinnedMesh) skin = object; });
const joint = suffix => skin.skeleton.bones.findIndex(bone => bone.name.endsWith(suffix));
const armIndex = joint('LeftForeArm'), handIndex = joint('LeftHand');
assert.ok(armIndex >= 0 && handIndex >= 0);
const shootMixer = new THREE.AnimationMixer(shootRoot);
shootMixer.clipAction(shoot).setLoop(THREE.LoopOnce, 1).play().clampWhenFinished = true;
const baseline = process.argv[2] ? await loadAsset(process.argv[2]) : null;
const baselineMixer = baseline ? new THREE.AnimationMixer(baseline.scene) : null;
if (baselineMixer) baselineMixer.clipAction(baseline.animations.find(clip => clip.name === 'Shoot')).setLoop(THREE.LoopOnce, 1).play().clampWhenFinished = true;
const deformationRotation = index => new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().extractRotation(skin.skeleton.bones[index].matrixWorld.clone().multiply(skin.skeleton.boneInverses[index])),
).normalize();
let maxWristAngle = 0, maxJointPositionError = 0, maxOtherBoneMatrixError = 0;
for (let frame = 0; frame <= 80; frame++) {
  const time = shoot.duration * frame / 80;
  shootMixer.setTime(time); shootRoot.updateMatrixWorld(true);
  const angle = THREE.MathUtils.radToDeg(deformationRotation(armIndex).angleTo(deformationRotation(handIndex)));
  maxWristAngle = Math.max(maxWristAngle, angle);
  assert.ok(angle < 90, `Shoot wrist twist is excessive at ${time}: ${angle}`);
  if (baselineMixer) {
    baselineMixer.setTime(time); baseline.scene.updateMatrixWorld(true);
    for (const bone of skin.skeleton.bones) {
      const expected = baseline.scene.getObjectByName(bone.name);
      maxJointPositionError = Math.max(maxJointPositionError,
        bone.getWorldPosition(new THREE.Vector3()).distanceTo(expected.getWorldPosition(new THREE.Vector3())));
      if (bone.name.endsWith('LeftForeArm')) continue;
      bone.matrixWorld.elements.forEach((value, index) => {
        maxOtherBoneMatrixError = Math.max(maxOtherBoneMatrixError, Math.abs(value - expected.matrixWorld.elements[index]));
      });
    }
  }
}
if (baseline) {
  assert.ok(maxJointPositionError < 0.0001, `Joint position changed: ${maxJointPositionError}`);
  assert.ok(maxOtherBoneMatrixError < 0.001, `Other bone pose changed: ${maxOtherBoneMatrixError}`);
  for (const name of ['Idle', 'Walk', 'Shoot', 'RifleIdle', 'RifleWalk']) {
    const current = asset.animations.find(clip => clip.name === name).toJSON();
    const previous = baseline.animations.find(clip => clip.name === name).toJSON();
    delete current.uuid; delete previous.uuid;
    assert.deepEqual(current, previous, `${name} changed during wrist repair`);
  }
}
shootMixer.stopAllAction(); shootMixer.uncacheRoot(shootRoot);
baselineMixer?.stopAllAction();
console.log(JSON.stringify({ test: 'Shoot wrist', samples: 81, maxWristAngle, baselineChecked: Boolean(baseline), maxJointPositionError, maxOtherBoneMatrixError }));

// New armed locomotion must also keep the left wrist intact at subframes.
for (const name of ['RifleIdle', 'RifleWalk', 'RifleJog', 'RifleRun', 'Reload']) {
  const clip = name === 'RifleJog' ? rifleJog : asset.animations.find(candidate => candidate.name === name);
  const rig = clone(asset.scene);
  let armedSkin;
  rig.traverse(object => { if (object.isSkinnedMesh) armedSkin = object; });
  const forearmIndex = armedSkin.skeleton.bones.findIndex(bone => bone.name.endsWith('LeftForeArm'));
  const wristIndex = armedSkin.skeleton.bones.findIndex(bone => bone.name.endsWith('LeftHand'));
  const mixer = new THREE.AnimationMixer(rig);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1).play();
  action.clampWhenFinished = true;
  const capturePose = time => {
    mixer.setTime(time); rig.updateMatrixWorld(true);
    return armedSkin.skeleton.bones.map(bone => ({
      position: bone.getWorldPosition(new THREE.Vector3()),
      rotation: bone.getWorldQuaternion(new THREE.Quaternion()),
    }));
  };
  const first = capturePose(0), next = capturePose(1 / 30);
  const previous = capturePose(clip.duration - 1 / 30), last = capturePose(clip.duration);
  let maxSeamPosition = 0, maxSeamAngle = 0;
  let maxSeamVelocityDelta = 0, maxSeamAngularVelocityDelta = 0;
  first.forEach((pose, index) => {
    maxSeamPosition = Math.max(maxSeamPosition, pose.position.distanceTo(last[index].position));
    maxSeamAngle = Math.max(maxSeamAngle, THREE.MathUtils.radToDeg(pose.rotation.angleTo(last[index].rotation)));
    maxSeamVelocityDelta = Math.max(maxSeamVelocityDelta, last[index].position.clone().sub(previous[index].position)
      .distanceTo(next[index].position.clone().sub(pose.position)));
    const incoming = previous[index].rotation.clone().invert().multiply(last[index].rotation);
    const outgoing = pose.rotation.clone().invert().multiply(next[index].rotation);
    maxSeamAngularVelocityDelta = Math.max(maxSeamAngularVelocityDelta,
      THREE.MathUtils.radToDeg(incoming.angleTo(outgoing)));
  });
  assert.ok(maxSeamPosition < 0.02 && maxSeamAngle < 3,
    `${name} loop seam is discontinuous: ${maxSeamPosition} units, ${maxSeamAngle}°`);
  if (name === 'RifleRun') {
    assert.ok(maxSeamVelocityDelta < 0.03 && maxSeamAngularVelocityDelta < 4,
      `RifleRun loop changes velocity abruptly: ${maxSeamVelocityDelta} units, ${maxSeamAngularVelocityDelta}°`);
  }
  let maxAngle = 0;
  for (let frame = 0; frame <= 120; frame++) {
    mixer.setTime(clip.duration * frame / 120); rig.updateMatrixWorld(true);
    const rotation = index => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(
      armedSkin.skeleton.bones[index].matrixWorld.clone().multiply(armedSkin.skeleton.boneInverses[index]),
    )).normalize();
    maxAngle = Math.max(maxAngle, THREE.MathUtils.radToDeg(rotation(forearmIndex).angleTo(rotation(wristIndex))));
  }
  assert.ok(maxAngle < 90, `${name} left wrist twist is excessive: ${maxAngle}`);
  mixer.stopAllAction(); mixer.uncacheRoot(rig);
  console.log(JSON.stringify({ test: `${name} wrist and loop`, samples: 121, maxAngle, maxSeamPosition, maxSeamAngle,
    maxSeamVelocityDelta, maxSeamAngularVelocityDelta }));
}
