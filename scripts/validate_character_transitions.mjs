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
const buffer = fs.readFileSync(new URL('../ksman_v3_walk_1k_meshopt.glb', import.meta.url));
const length = buffer.readUInt32LE(12);
const json = JSON.parse(buffer.subarray(20, 20 + length).toString());
json.buffers[0].uri = `data:application/octet-stream;base64,${buffer.subarray(28 + length).toString('base64')}`;
for (const mesh of json.meshes) for (const primitive of mesh.primitives) delete primitive.material;
delete json.materials; delete json.textures; delete json.images;
for (const key of ['extensionsUsed', 'extensionsRequired']) {
  if (json[key]) json[key] = json[key].filter(value => value !== 'EXT_texture_webp');
}
const asset = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(JSON.stringify(json), '');
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
