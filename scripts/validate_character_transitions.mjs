// Run after TypeScript compilation via npm run test:animation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CharacterAnimationController } from '../.animation-test-dist/src/characters/animation-controller.js';
import { AnimatedCharacter } from '../.animation-test-dist/src/characters/animated-character.js';

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
const asset = await loadAsset(new URL('../ksman_v3_walk_1k_meshopt.glb', import.meta.url));
for (const name of ['Idle', 'Walk', 'Shoot', 'RifleIdle', 'RifleWalk']) {
  assert.ok(asset.animations.some(clip => clip.name === name), `Missing ${name} clip`);
}
const armedClips = { idle: /^RifleIdle$/i, walk: /^RifleWalk$/i, shoot: /^Shoot$/i };
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

// Exercise the game wrapper as well, including normalization and skin cloning.
const config = { url: 'test-player', height: 118, shootUpperBodyOnly: true, shootPulseEndSeconds: 0.3, heldWeapon: 'smg', clips: armedClips };
const player = new AnimatedCharacter(asset, config);
const other = new AnimatedCharacter(asset, config);
const rightHand = player.root.getObjectByName('mixamorigRightHand');
const weapon = player.root.getObjectByName('heldSmg');
assert.ok(rightHand?.isBone && weapon && player.muzzleSocket, 'Player gun or muzzle socket is missing');
assert.ok(rightHand.getObjectByName('weaponSocket')?.getObjectByName('heldSmg') === weapon,
  'The gun must follow the right-hand bone');
assert.notEqual(player.muzzleSocket, other.muzzleSocket, 'Muzzle sockets are shared between characters');
const muzzleForward = () => new THREE.Vector3(0, 0, 1).applyQuaternion(
  player.muzzleSocket.getWorldQuaternion(new THREE.Quaternion()));
const neutralDirection = muzzleForward();
assert.ok(neutralDirection.z > 0.75 && neutralDirection.y < -0.25,
  `Idle gun should be lowered forward, not at the feet: ${neutralDirection.toArray()}`);
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
player.dispose(); other.dispose(); controller.dispose();
console.log(JSON.stringify({ test: 'runtime player transitions', bones: bones.length, frames: 1200, zeroTimePoseError, zeroTimeShootError, lowerBodyPoseError, returnedArmPoseError, rapidShotPoseError, rapidShotCount, singlePulseDuration, height: 118, grounded: true, independent: true, shootFallback: true, shootStarts, maxShootTime }));

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
  for (const name of ['Idle', 'Walk']) {
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
for (const name of ['RifleIdle', 'RifleWalk']) {
  const clip = asset.animations.find(candidate => candidate.name === name);
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
  const first = capturePose(0), last = capturePose(clip.duration);
  let maxSeamPosition = 0, maxSeamAngle = 0;
  first.forEach((pose, index) => {
    maxSeamPosition = Math.max(maxSeamPosition, pose.position.distanceTo(last[index].position));
    maxSeamAngle = Math.max(maxSeamAngle, THREE.MathUtils.radToDeg(pose.rotation.angleTo(last[index].rotation)));
  });
  assert.ok(maxSeamPosition < 0.02 && maxSeamAngle < 3,
    `${name} loop seam is discontinuous: ${maxSeamPosition} units, ${maxSeamAngle}°`);
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
  console.log(JSON.stringify({ test: `${name} wrist and loop`, samples: 121, maxAngle, maxSeamPosition, maxSeamAngle }));
}
