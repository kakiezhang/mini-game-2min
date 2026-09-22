import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import "./character-preview.css";

const DEFAULT_MODEL_URL = "/ksman_v3_walk_1k_meshopt.glb";
const DEFAULT_MODEL_NAME = "ksman_v3_walk_1k_meshopt.glb";

const canvas = document.querySelector<HTMLCanvasElement>("#character-preview-canvas")!;
const status = document.querySelector<HTMLElement>("#load-status")!;
const statusText = document.querySelector<HTMLElement>("#load-status-text")!;
const fileName = document.querySelector<HTMLElement>("#file-name")!;
const fileInput = document.querySelector<HTMLInputElement>("#model-file")!;
const animationSelect = document.querySelector<HTMLSelectElement>("#animation-select")!;
const playToggle = document.querySelector<HTMLButtonElement>("#play-toggle")!;
const timeline = document.querySelector<HTMLInputElement>("#timeline")!;
const timeOutput = document.querySelector<HTMLOutputElement>("#time-output")!;
const speedInput = document.querySelector<HTMLInputElement>("#speed")!;
const speedOutput = document.querySelector<HTMLOutputElement>("#speed-output")!;
const loopToggle = document.querySelector<HTMLInputElement>("#loop-toggle")!;
const skeletonToggle = document.querySelector<HTMLInputElement>("#skeleton-toggle")!;
const resetViewButton = document.querySelector<HTMLButtonElement>("#reset-view")!;
const dropZone = document.querySelector<HTMLElement>("#drop-zone")!;
const statAnimation = document.querySelector<HTMLElement>("#stat-animation")!;
const statDuration = document.querySelector<HTMLElement>("#stat-duration")!;
const statTriangles = document.querySelector<HTMLElement>("#stat-triangles")!;
const statBones = document.querySelector<HTMLElement>("#stat-bones")!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080b10);
scene.fog = new THREE.FogExp2(0x080b10, 0.035);

const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.enablePan = false;
controls.minDistance = 1;
controls.maxDistance = 14;
controls.maxPolarAngle = Math.PI * 0.52;

const modelStage = new THREE.Group();
scene.add(modelStage);

scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x202018, 2.1));
const keyLight = new THREE.DirectionalLight(0xfff4e4, 3.4);
keyLight.position.set(3.5, 6, 4.5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 0.1;
keyLight.shadow.camera.far = 18;
keyLight.shadow.camera.left = -4;
keyLight.shadow.camera.right = 4;
keyLight.shadow.camera.top = 5;
keyLight.shadow.camera.bottom = -1;
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0x65d9ff, 2.4);
rimLight.position.set(-4, 3.5, -4);
scene.add(rimLight);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(4.8, 96),
  new THREE.MeshStandardMaterial({ color: 0x171d23, roughness: 0.92, metalness: 0.08 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(9.6, 24, 0x35444d, 0x202a31);
grid.position.y = 0.003;
const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
for (const material of gridMaterials) {
  material.transparent = true;
  material.opacity = 0.38;
}
scene.add(grid);

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const clock = new THREE.Clock();
let activeGltf: GLTF | undefined;
let mixer: THREE.AnimationMixer | undefined;
let activeAction: THREE.AnimationAction | undefined;
let activeClip: THREE.AnimationClip | undefined;
let skeletonHelper: THREE.SkeletonHelper | undefined;
let isPlaying = true;
let isScrubbing = false;
let playbackSpeed = 1;

const setStatus = (message: string, state: "loading" | "ready" | "error") => {
  status.dataset.state = state;
  statusText.textContent = message;
};

const formatTime = (seconds: number) => seconds.toFixed(2);

const updateTimeDisplay = () => {
  const duration = activeClip?.duration ?? 0;
  const current = activeAction?.time ?? 0;
  if (!isScrubbing) timeline.value = String(Math.min(current, duration));
  timeOutput.value = `${formatTime(current)} / ${formatTime(duration)} s`;
};

const updatePlayButton = () => {
  playToggle.textContent = isPlaying ? "Ⅱ" : "▶";
  playToggle.ariaLabel = isPlaying ? "暂停动画" : "播放动画";
};

const applyLoopMode = () => {
  if (!activeAction) return;
  activeAction.setLoop(loopToggle.checked ? THREE.LoopRepeat : THREE.LoopOnce, loopToggle.checked ? Infinity : 1);
  activeAction.clampWhenFinished = !loopToggle.checked;
};

const chooseAnimation = (index: number) => {
  if (!activeGltf || !mixer) return;
  const clip = activeGltf.animations[index];
  if (!clip) return;

  mixer.stopAllAction();
  activeClip = clip;
  activeAction = mixer.clipAction(clip);
  activeAction.reset().play();
  applyLoopMode();
  isPlaying = true;
  timeline.max = String(Math.max(clip.duration, 0.001));
  timeline.value = "0";
  statAnimation.textContent = clip.name || `动作 ${index + 1}`;
  statDuration.textContent = `${formatTime(clip.duration)} 秒`;
  updatePlayButton();
  updateTimeDisplay();
};

const disposeObject = (root: THREE.Object3D) => {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
};

const clearCurrentModel = () => {
  mixer?.stopAllAction();
  if (skeletonHelper) {
    scene.remove(skeletonHelper);
    skeletonHelper.dispose();
    skeletonHelper = undefined;
  }
  if (activeGltf) {
    modelStage.remove(activeGltf.scene);
    disposeObject(activeGltf.scene);
  }
  activeGltf = undefined;
  mixer = undefined;
  activeAction = undefined;
  activeClip = undefined;
};

const frameModel = (root: THREE.Object3D) => {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  if (bounds.isEmpty()) return;

  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.y -= bounds.min.y;
  root.position.z -= center.z;
  root.updateMatrixWorld(true);

  const framedHeight = Math.max(size.y, 0.5);
  const target = new THREE.Vector3(0, framedHeight * 0.48, 0);
  const distance = Math.max(framedHeight * 1.55, size.x * 2.2, size.z * 2.2, 2.6);
  camera.position.set(distance * 0.7, framedHeight * 0.55, distance);
  camera.near = Math.max(distance / 1000, 0.005);
  camera.far = distance * 15;
  camera.updateProjectionMatrix();
  controls.target.copy(target);
  controls.minDistance = Math.max(framedHeight * 0.45, 0.5);
  controls.maxDistance = Math.max(framedHeight * 6, 8);
  controls.update();
};

const updateStats = (root: THREE.Object3D) => {
  let triangles = 0;
  const bones = new Set<THREE.Bone>();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      const geometry = object.geometry;
      triangles += geometry.index ? geometry.index.count / 3 : (geometry.getAttribute("position")?.count ?? 0) / 3;
    }
    if (object instanceof THREE.SkinnedMesh) {
      for (const bone of object.skeleton.bones) bones.add(bone);
    }
  });
  statTriangles.textContent = Math.round(triangles).toLocaleString("zh-CN");
  statBones.textContent = bones.size.toLocaleString("zh-CN");
};

const installModel = (gltf: GLTF, name: string) => {
  clearCurrentModel();
  activeGltf = gltf;
  fileName.textContent = name;

  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
  modelStage.add(gltf.scene);
  frameModel(gltf.scene);
  updateStats(gltf.scene);

  skeletonHelper = new THREE.SkeletonHelper(gltf.scene);
  skeletonHelper.visible = skeletonToggle.checked;
  scene.add(skeletonHelper);

  mixer = new THREE.AnimationMixer(gltf.scene);
  animationSelect.replaceChildren();
  gltf.animations.forEach((clip, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = clip.name || `动作 ${index + 1}`;
    animationSelect.appendChild(option);
  });

  const hasAnimation = gltf.animations.length > 0;
  animationSelect.disabled = !hasAnimation;
  playToggle.disabled = !hasAnimation;
  timeline.disabled = !hasAnimation;
  if (hasAnimation) {
    chooseAnimation(0);
    setStatus("模型与动作已就绪", "ready");
  } else {
    statAnimation.textContent = "无动画";
    statDuration.textContent = "—";
    timeOutput.value = "0.00 / 0.00 s";
    setStatus("模型已加载，但没有动作", "error");
  }
};

const loadModel = async (url: string, name: string, revokeAfterLoad = false) => {
  setStatus("正在加载模型", "loading");
  playToggle.disabled = true;
  try {
    const gltf = await loader.loadAsync(url);
    installModel(gltf, name);
  } catch (error) {
    console.error("Failed to load character preview model", error);
    setStatus("模型加载失败", "error");
    fileName.textContent = name;
  } finally {
    if (revokeAfterLoad) URL.revokeObjectURL(url);
  }
};

const loadLocalFile = (file: File) => {
  if (!file.name.toLowerCase().endsWith(".glb")) {
    setStatus("请选择 .glb 文件", "error");
    return;
  }
  void loadModel(URL.createObjectURL(file), file.name, true);
};

playToggle.addEventListener("click", () => {
  if (!activeAction) return;
  if (!isPlaying && !loopToggle.checked && activeClip && activeAction.time >= activeClip.duration) activeAction.reset();
  isPlaying = !isPlaying;
  updatePlayButton();
});

animationSelect.addEventListener("change", () => chooseAnimation(Number(animationSelect.value)));

timeline.addEventListener("pointerdown", () => { isScrubbing = true; });
timeline.addEventListener("pointerup", () => { isScrubbing = false; });
timeline.addEventListener("input", () => {
  if (!activeAction || !activeClip) return;
  activeAction.time = Number(timeline.value);
  mixer?.update(0);
  timeOutput.value = `${formatTime(activeAction.time)} / ${formatTime(activeClip.duration)} s`;
});

speedInput.addEventListener("input", () => {
  playbackSpeed = Number(speedInput.value);
  speedOutput.value = `${playbackSpeed.toFixed(2)}×`;
});

loopToggle.addEventListener("change", applyLoopMode);
skeletonToggle.addEventListener("change", () => {
  if (skeletonHelper) skeletonHelper.visible = skeletonToggle.checked;
});
resetViewButton.addEventListener("click", () => { if (activeGltf) frameModel(activeGltf.scene); });
renderer.domElement.addEventListener("dblclick", () => { if (activeGltf) frameModel(activeGltf.scene); });
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadLocalFile(file);
  fileInput.value = "";
});

let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth += 1;
  dropZone.dataset.active = "true";
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) delete dropZone.dataset.active;
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  delete dropZone.dataset.active;
  const file = event.dataTransfer?.files[0];
  if (file) loadLocalFile(file);
});

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.code === "Space") {
    event.preventDefault();
    playToggle.click();
  } else if (event.key.toLowerCase() === "r") {
    resetViewButton.click();
  } else if (event.key.toLowerCase() === "s") {
    skeletonToggle.click();
  }
});

const resize = () => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
};
window.addEventListener("resize", resize);
resize();

renderer.setAnimationLoop(() => {
  const delta = Math.min(clock.getDelta(), 0.05);
  if (mixer && activeAction && activeClip && isPlaying && !isScrubbing) {
    mixer.update(delta * playbackSpeed);
    if (!loopToggle.checked && activeAction.time >= activeClip.duration) {
      isPlaying = false;
      updatePlayButton();
    }
  }
  controls.update();
  updateTimeDisplay();
  renderer.render(scene, camera);
});

void loadModel(DEFAULT_MODEL_URL, DEFAULT_MODEL_NAME);
