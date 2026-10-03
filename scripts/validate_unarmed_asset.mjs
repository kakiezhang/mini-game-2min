import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

globalThis.ProgressEvent ??= class { constructor(type, values) { Object.assign(this, values); } };
async function read(file) {
  const bytes = fs.readFileSync(file), length = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString());
  const report = { bytes: bytes.length, bones: json.skins[0].joints.length,
    triangles: json.meshes.reduce((n,m) => n + m.primitives.reduce((s,p) => s + json.accessors[p.indices].count / 3,0),0),
    imageTypes: json.images.map(i => i.mimeType), extensions: json.extensionsRequired };
  json.buffers[0].uri = `data:application/octet-stream;base64,${bytes.subarray(28 + length).toString('base64')}`;
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  delete json.materials; delete json.textures; delete json.images;
  for (const key of ['extensionsUsed','extensionsRequired']) if(json[key]) json[key]=json[key].filter(e=>e!=='EXT_texture_webp');
  return { asset: await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(JSON.stringify(json),''), report };
}
const current = await read('ksman_v3_unarmed_moves_review_1k_meshopt.glb');
assert.equal(current.report.bones,65);
assert(current.report.imageTypes.every(t=>t==='image/webp'));
assert(current.report.extensions.includes('EXT_meshopt_compression'));
assert.equal(current.asset.animations.length,16);
const cross=current.asset.animations.find(a=>a.name==='PunchRightCross');
assert(cross && Math.abs(cross.duration-23/30)<1e-6);
let unchangedClips=0;
if(process.argv[2]) {
  const previous=await read(process.argv[2]);
  assert.equal(current.report.triangles,previous.report.triangles);
  for(const old of previous.asset.animations) {
    const clip=current.asset.animations.find(a=>a.name===old.name);
    assert(clip,`Missing previous clip ${old.name}`);
    assert.equal(clip.duration,old.duration,`${old.name} duration changed`);
    assert.equal(clip.tracks.length,old.tracks.length);
    for(const track of old.tracks) {
      const next=clip.tracks.find(t=>t.name===track.name);
      assert(next,`Missing track ${old.name}/${track.name}`);
      assert.deepEqual(next.times,track.times,`${old.name}/${track.name} times changed`);
      assert.deepEqual(next.values,track.values,`${old.name}/${track.name} poses changed`);
    }
    unchangedClips++;
  }
}
console.log(JSON.stringify({...current.report,clips:current.asset.animations.map(a=>({name:a.name,seconds:a.duration})),unchangedClips}));
