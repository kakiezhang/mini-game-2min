// CPU regression checks against the actual Meshopt asset used by Three.js.
// node scripts/validate_character_loop.mjs <new.glb> [before.glb]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

globalThis.ProgressEvent ??= class {
  constructor(type, values) { this.type = type; Object.assign(this, values); }
};

async function load(path) {
  const data = fs.readFileSync(path);
  const length = data.readUInt32LE(12);
  const json = JSON.parse(data.subarray(20, 20 + length).toString());
  json.buffers[0].uri = `data:application/octet-stream;base64,${data.subarray(28 + length).toString('base64')}`;
  // Only texture decoding requires a browser; retain skin and animation data.
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  delete json.materials; delete json.textures; delete json.images;
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    if (json[key]) json[key] = json[key].filter(value => value !== 'EXT_texture_webp');
  }
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(JSON.stringify(json), '');
}

function sampler(gltf, name) {
  const clip = gltf.animations.find(animation => animation.name === name);
  assert.ok(clip, `Missing ${name}`);
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const action = mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1).play();
  action.clampWhenFinished = true;
  const bones = [];
  gltf.scene.traverse(object => { if (object.isBone) bones.push(object); });
  assert.equal(bones.length, 65);
  return time => {
    mixer.setTime(time);
    gltf.scene.updateMatrixWorld(true);
    return Object.fromEntries(bones.map(bone => [bone.name, {
      p: bone.getWorldPosition(new THREE.Vector3()),
      q: bone.getWorldQuaternion(new THREE.Quaternion()).normalize(),
      s: bone.getWorldScale(new THREE.Vector3()),
    }]));
  };
}

const input = process.argv[2] ?? 'ksman_v3_walk_1k_meshopt.glb';
const gltf = await load(input);
const idle = gltf.animations.find(clip => clip.name === 'Idle');
assert.equal(idle?.duration, 3, 'Keep the original three-second selection');
const sample = sampler(gltf, 'Idle');
const frames = Array.from({ length: 91 }, (_, frame) => sample(frame / 30));
let seamPosition = 0, seamAngle = 0, seamScale = 0;
let seamVelocityDelta = 0, seamAngularVelocityDelta = 0, maxFrameStep = 0;
let worstVelocityBone;
for (const name of Object.keys(frames[0])) {
  const first = frames[0][name], next = frames[1][name];
  const previous = frames[89][name], last = frames[90][name];
  seamPosition = Math.max(seamPosition, first.p.distanceTo(last.p));
  seamAngle = Math.max(seamAngle, first.q.angleTo(last.q));
  seamScale = Math.max(seamScale, first.s.distanceTo(last.s));
  const velocityDelta = last.p.clone().sub(previous.p).distanceTo(next.p.clone().sub(first.p));
  if (velocityDelta > seamVelocityDelta) { seamVelocityDelta = velocityDelta; worstVelocityBone = name; }
  const incoming = previous.q.clone().invert().multiply(last.q);
  const outgoing = first.q.clone().invert().multiply(next.q);
  seamAngularVelocityDelta = Math.max(seamAngularVelocityDelta, incoming.angleTo(outgoing));
  for (let index = 1; index < frames.length; index++) {
    const pose = frames[index][name];
    assert.ok([...pose.p, ...pose.q, ...pose.s].every(Number.isFinite));
    maxFrameStep = Math.max(maxFrameStep, pose.p.distanceTo(frames[index - 1][name].p));
  }
}
assert.ok(seamPosition < 1e-5, `Endpoint position mismatch: ${seamPosition}`);
assert.ok(seamAngle < 1e-4, `Endpoint angle mismatch: ${seamAngle}`);
assert.ok(seamScale < 1e-5, `Endpoint scale mismatch: ${seamScale}`);
assert.ok(seamVelocityDelta < 0.0001, `Velocity discontinuity: ${seamVelocityDelta}`);
assert.ok(seamAngularVelocityDelta < 0.001, `Angular velocity discontinuity: ${seamAngularVelocityDelta}`);
assert.ok(maxFrameStep < 0.005, `Unexpected body jump: ${maxFrameStep}`);

// Exercise actual LoopRepeat, including several wraps between sampled frames.
const copy = clone(gltf.scene);
const loopMixer = new THREE.AnimationMixer(copy);
loopMixer.clipAction(idle).play();
let loopCount = 0;
loopMixer.addEventListener('loop', () => { loopCount++; });
const boneNames = Object.keys(frames[0]);
const originalPoses = boneNames.map(name => gltf.scene.getObjectByName(name).matrixWorld.clone());
const previousPositions = {};
let maxRepeatStep = 0;
for (let frame = 0; frame < 600; frame++) {
  loopMixer.update(1 / 60);
  copy.updateMatrixWorld(true);
  for (const name of boneNames) {
    const position = copy.getObjectByName(name).getWorldPosition(new THREE.Vector3());
    if (previousPositions[name]) maxRepeatStep = Math.max(maxRepeatStep, position.distanceTo(previousPositions[name]));
    previousPositions[name] = position;
  }
}
assert.ok(loopCount >= 3);
assert.ok(maxRepeatStep < 0.005);
for (const [index, name] of boneNames.entries()) {
  assert.ok(gltf.scene.getObjectByName(name).matrixWorld.equals(originalPoses[index]), 'Clone changed original rig');
}

let unchangedPositionError = null;
if (process.argv[3]) {
  const before = await load(process.argv[3]);
  const reference = sampler(before, 'Idle');
  unchangedPositionError = 0;
  for (let frame = 0; frame <= 72; frame++) {
    const expected = reference(frame / 30);
    for (const [name, pose] of Object.entries(frames[frame])) {
      unchangedPositionError = Math.max(unchangedPositionError, pose.p.distanceTo(expected[name].p));
      assert.ok(pose.q.angleTo(expected[name].q) < 1e-4, `Modified opening rotation: ${frame} ${name}`);
    }
  }
  assert.ok(unchangedPositionError < 1e-5, 'Modified first 2.4 seconds');
  const walk = asset => asset.animations.find(clip => clip.name === 'Walk').toJSON();
  const newWalk = walk(gltf), oldWalk = walk(before);
  delete newWalk.uuid; delete oldWalk.uuid;
  assert.deepEqual(newWalk, oldWalk, 'Walk animation changed');
}
console.log(JSON.stringify({ input, duration: idle.duration, bones: 65,
  seamPosition, seamAngle, seamScale, seamVelocityDelta, seamAngularVelocityDelta,
  maxFrameStep, worstVelocityBone, loopCount, maxRepeatStep, unchangedPositionError }, null, 2));
