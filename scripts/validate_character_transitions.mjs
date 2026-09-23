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
const root = clone(asset.scene);
const controller = new CharacterAnimationController(root, asset.animations, { clips: { idle: /^idle$/i, walk: /^walk$/i } });
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

// Exercise the game wrapper as well, including normalization and skin cloning.
const config = { url: 'test-player', height: 118, clips: { idle: /^idle$/i, walk: /^walk$/i } };
const player = new AnimatedCharacter(asset, config);
const other = new AnimatedCharacter(asset, config);
const bounds = new THREE.Box3().setFromObject(player.root);
assert.ok(Math.abs(bounds.getSize(new THREE.Vector3()).y - 118) < 1e-4);
assert.ok(Math.abs(bounds.min.y) < 1e-4);
const otherBone = other.root.getObjectByName(bones[0].name);
other.root.updateMatrixWorld(true);
const otherPose = otherBone.matrixWorld.clone();
for (let frame = 0; frame < 180; frame++) { player.setMovement(frame % 10 < 5 ? 1 : 0, 0); player.update(1 / 60); }
other.root.updateMatrixWorld(true);
assert.ok(otherBone.matrixWorld.equals(otherPose), 'Game instances share mutable bone state');
player.dispose(); other.dispose(); controller.dispose();
console.log(JSON.stringify({ test: 'runtime player transitions', bones: bones.length, frames: 1200, zeroTimePoseError, height: 118, grounded: true, independent: true }));

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
