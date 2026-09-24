import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { CharacterAnimationController } from "./characters/animation-controller.js";
import { attachPlayerSmg, type HeldWeaponVisual } from "./weapon-visual.js";
import "./character-preview.css";

const DEFAULT_MODEL_URL = `${new URL("../ksman_v3_walk_1k_meshopt.glb", import.meta.url).href}?preview=${Date.now()}`;
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
const singleModeButton = document.querySelector<HTMLButtonElement>("#single-mode")!;
const transitionModeButton = document.querySelector<HTMLButtonElement>("#transition-mode")!;
const singleControls = document.querySelector<HTMLElement>("#single-controls")!;
const transitionControls = document.querySelector<HTMLElement>("#transition-controls")!;
const modeHint = document.querySelector<HTMLElement>("#mode-hint")!;
const holdMove = document.querySelector<HTMLButtonElement>("#hold-move")!;
const shootAction = document.querySelector<HTMLButtonElement>("#shoot-action")!;
const autoTransition = document.querySelector<HTMLButtonElement>("#auto-transition")!;
const transitionPause = document.querySelector<HTMLButtonElement>("#transition-pause")!;
const transitionState = document.querySelector<HTMLOutputElement>("#transition-state")!;
const locomotionState = document.querySelector<HTMLOutputElement>("#locomotion-state")!;
const transitionStatus = document.querySelector<HTMLOutputElement>("#transition-status")!;
const blendWeights = document.querySelector<HTMLOutputElement>("#blend-weights")!;
const idleWeightBar = document.querySelector<HTMLElement>("#idle-weight-bar")!;
const walkWeightBar = document.querySelector<HTMLElement>("#walk-weight-bar")!;
const shootWeightBar = document.querySelector<HTMLElement>("#shoot-weight-bar")!;

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
let heldWeapon: HeldWeaponVisual | undefined;
let mixer: THREE.AnimationMixer | undefined;
let activeAction: THREE.AnimationAction | undefined;
let activeClip: THREE.AnimationClip | undefined;
let skeletonHelper: THREE.SkeletonHelper | undefined;
let isPlaying = true;
let isScrubbing = false;
let playbackSpeed = 1;
let transitionController: CharacterAnimationController | undefined;
let reviewMode: "single" | "transition" = "single";
let keyHeld = false;
let heldPointer: number | undefined;
let autoEnabled = false;
let autoTime = 0;
let autoShootSegment = -1;
let transitionPaused = false;
let loadVersion = 0;

const updateTransitionDisplay = () => {
  const snapshot = transitionController?.getSnapshot();
  if (!snapshot) return;
  const idle = snapshot.actions.find(action => action.state === "idle");
  const walk = snapshot.actions.find(action => action.state === "walk");
  const shoot = snapshot.actions.find(action => action.state === "shoot");
  const labels = { idle: "Idle", walk: "Walk", shoot: "Shoot" } as const;
  transitionState.value = labels[snapshot.state as keyof typeof labels] ?? snapshot.state ?? "—";
  locomotionState.value = labels[snapshot.locomotionState];
  const statusLabel = transitionPaused ? "暂停" : snapshot.oneShotState ? "一次性动作" : snapshot.transitioning ? "混合中" : "稳定";
  transitionStatus.value = `${statusLabel} · ${snapshot.transitionDuration.toFixed(2)} s`;
  blendWeights.value = `Idle ${Math.round((idle?.weight ?? 0) * 100)}% · Walk ${Math.round((walk?.weight ?? 0) * 100)}% · Shoot ${Math.round((shoot?.weight ?? 0) * 100)}%`;
  idleWeightBar.style.width = `${(idle?.weight ?? 0) * 100}%`;
  walkWeightBar.style.width = `${(walk?.weight ?? 0) * 100}%`;
  shootWeightBar.style.width = `${(shoot?.weight ?? 0) * 100}%`;
  const active = snapshot.actions.find(action => action.state === snapshot.state);
  statAnimation.textContent = `${transitionState.value}${snapshot.transitioning ? " · 混合中" : ""}`;
  statDuration.textContent = active ? `${active.duration.toFixed(2)} 秒` : "—";
};

const applyTestMovement = () => {
  const held = keyHeld || heldPointer !== undefined;
  const segment = Math.floor(autoTime / 3);
  const phase = autoTime % 3;
  const moving = held || (autoEnabled && segment % 2 === 1);
  holdMove.setAttribute("aria-pressed", String(held));
  autoTransition.setAttribute("aria-pressed", String(autoEnabled));
  autoTransition.textContent = autoEnabled ? "停止自动流程" : "自动完整流程";
  transitionController?.setMovement(moving ? 1 : 0, 0);
  if (autoEnabled && phase >= 0.75 && autoShootSegment !== segment) {
    autoShootSegment = segment;
    transitionController?.playOneShot("shoot");
  }
  updateTransitionDisplay();
};

const releaseTestInput = () => {
  keyHeld = false;
  const pointer = heldPointer;
  heldPointer = undefined;
  if (pointer !== undefined && holdMove.hasPointerCapture(pointer)) holdMove.releasePointerCapture(pointer);
  autoEnabled = false;
  autoTime = 0;
  autoShootSegment = -1;
  applyTestMovement();
};

const setStatus = (message: string, state: "loading" | "ready" | "error") => {
  status.dataset.state = state;
  statusText.textContent = message;
};

const formatTime = (seconds: number) => seconds.toFixed(2);

const updateTimeDisplay = () => {
  if (reviewMode === "transition") return;
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
  mixer.update(0);
  activeGltf.scene.updateMatrixWorld(true);
  isPlaying = true;
  timeline.max = String(Math.max(clip.duration, 0.001));
  timeline.value = "0";
  statAnimation.textContent = clip.name || `动作 ${index + 1}`;
  statDuration.textContent = `${formatTime(clip.duration)} 秒`;
  if (reviewMode === "single") modeHint.textContent = clip.name.toLowerCase() === "shoot"
    && fileName.textContent === DEFAULT_MODEL_NAME
    ? "原始 Shoot 包含多次后坐力；切换测试显示游戏使用的单发片段"
    : "查看单段动作与循环接缝";
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
  releaseTestInput();
  transitionController?.dispose();
  transitionController = undefined;
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
  heldWeapon = undefined;
  mixer = undefined;
  activeAction = undefined;
  activeClip = undefined;
  isScrubbing = false;
};

const setReviewMode = (mode: "single" | "transition") => {
  if (mode === "transition" && transitionModeButton.disabled) return;
  releaseTestInput();
  transitionController?.dispose();
  transitionController = undefined;
  mixer?.stopAllAction();
  reviewMode = mode;
  document.body.dataset.reviewMode = mode;
  singleModeButton.setAttribute("aria-pressed", String(mode === "single"));
  transitionModeButton.setAttribute("aria-pressed", String(mode === "transition"));
  singleControls.hidden = mode !== "single";
  transitionControls.hidden = mode !== "transition";
  loopToggle.disabled = mode === "transition";
  isScrubbing = false;
  if (mode === "transition" && activeGltf) {
    const spine = activeGltf.scene.getObjectByName("mixamorigSpine");
    const shootUpperBodyOnly = spine instanceof THREE.Bone
      && spine.parent?.name === "mixamorigHips"
      && activeGltf.animations.some(clip => clip.name.toLowerCase() === "shoot");
    const shootClip = activeGltf.animations.find(clip => clip.name.toLowerCase() === "shoot");
    const shootPulseEndSeconds = shootUpperBodyOnly
      && fileName.textContent === DEFAULT_MODEL_NAME && (shootClip?.duration ?? 0) > 0.31 ? 0.3 : undefined;
    transitionController = new CharacterAnimationController(activeGltf.scene, activeGltf.animations, {
      clips: { idle: /^idle$/i, walk: /^walk$/i, shoot: /^shoot$/i },
      shootUpperBodyOnly,
      shootPulseEndSeconds,
    });
    transitionPaused = false;
    transitionPause.textContent = "暂停测试";
    modeHint.textContent = shootPulseEndSeconds
      ? "与游戏共用控制器 · 单发 Shoot 取原片前 0.30 秒、只覆盖上半身 · 腿部继续 Idle／Walk"
      : shootUpperBodyOnly
        ? "与游戏共用控制器 · Shoot 只覆盖上半身，腿部继续 Idle／Walk"
        : "与游戏共用控制器 · 移动过渡 0.12 秒 · Shoot 过渡 0.08 秒";
    updateTransitionDisplay();
  } else if (activeGltf) {
    chooseAnimation(Number(animationSelect.value));
    modeHint.textContent = transitionModeButton.disabled ? "切换测试需要 Idle 和 Walk 两个动作"
      : activeClip?.name.toLowerCase() === "shoot" && fileName.textContent === DEFAULT_MODEL_NAME
        ? "原始 Shoot 包含多次后坐力；切换测试显示游戏使用的单发片段"
        : "查看单段动作与循环接缝";
  }
  resize();
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
  updateStats(gltf.scene);
  if (name === DEFAULT_MODEL_NAME) heldWeapon = attachPlayerSmg(gltf.scene);

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
  transitionModeButton.disabled = !["idle", "walk"].every(name => gltf.animations.some(clip => clip.name.toLowerCase() === name));
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
  // Mixamo bind-pose axes may differ from the evaluated animation pose.
  frameModel(gltf.scene);
  setReviewMode("single");
};

const loadModel = async (url: string, name: string, revokeAfterLoad = false) => {
  const version = ++loadVersion;
  releaseTestInput();
  setStatus("正在加载模型", "loading");
  playToggle.disabled = true;
  transitionModeButton.disabled = true;
  holdMove.disabled = true;
  autoTransition.disabled = true;
  shootAction.disabled = true;
  try {
    const gltf = await loader.loadAsync(url);
    if (version !== loadVersion) { disposeObject(gltf.scene); return; }
    installModel(gltf, name);
  } catch (error) {
    if (version !== loadVersion) return;
    console.error("Failed to load character preview model", error);
    setStatus("模型加载失败", "error");
    fileName.textContent = name;
  } finally {
    if (version === loadVersion) {
      playToggle.disabled = !activeClip;
      transitionModeButton.disabled = !activeGltf || !["idle", "walk"].every(name => activeGltf!.animations.some(clip => clip.name.toLowerCase() === name));
      holdMove.disabled = transitionModeButton.disabled;
      const hasShoot = Boolean(activeGltf?.animations.some(clip => clip.name.toLowerCase() === "shoot"));
      shootAction.disabled = transitionModeButton.disabled || !hasShoot;
      autoTransition.disabled = transitionModeButton.disabled || !hasShoot;
    }
    if (revokeAfterLoad) URL.revokeObjectURL(url);
  }
};

singleModeButton.addEventListener("click", () => { setReviewMode("single"); singleModeButton.blur(); });
transitionModeButton.addEventListener("click", () => { setReviewMode("transition"); transitionModeButton.blur(); });
shootAction.addEventListener("click", () => {
  transitionController?.playOneShot("shoot");
  updateTransitionDisplay();
  shootAction.blur();
});
holdMove.addEventListener("pointerdown", event => {
  if (event.button !== 0 || heldPointer !== undefined || reviewMode !== "transition") return;
  event.preventDefault();
  heldPointer = event.pointerId;
  holdMove.setPointerCapture(event.pointerId);
  autoEnabled = false;
  applyTestMovement();
});
const releasePointer = (event: PointerEvent) => {
  if (heldPointer !== event.pointerId) return;
  heldPointer = undefined;
  applyTestMovement();
};
holdMove.addEventListener("pointerup", releasePointer);
holdMove.addEventListener("pointercancel", releasePointer);
holdMove.addEventListener("lostpointercapture", releasePointer);
holdMove.addEventListener("contextmenu", event => event.preventDefault());
autoTransition.addEventListener("click", () => {
  const enabled = !autoEnabled;
  releaseTestInput();
  autoEnabled = enabled;
  autoTime = 0;
  autoShootSegment = -1;
  applyTestMovement();
  autoTransition.blur();
});
transitionPause.addEventListener("click", () => {
  transitionPaused = !transitionPaused;
  transitionPause.textContent = transitionPaused ? "继续测试" : "暂停测试";
  updateTransitionDisplay();
  transitionPause.blur();
});
window.addEventListener("blur", releaseTestInput);
document.addEventListener("visibilitychange", () => { if (document.hidden) releaseTestInput(); });

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
  if (event.target instanceof HTMLElement && event.target.matches("input, select, textarea, [contenteditable=true]")) return;
  if (event.code === "Space") {
    if (event.target instanceof HTMLButtonElement && event.target !== holdMove) return;
    event.preventDefault();
    if (event.repeat) return;
    if (reviewMode === "transition" && !holdMove.disabled) {
      keyHeld = true;
      autoEnabled = false;
      applyTestMovement();
    } else if (reviewMode === "single") playToggle.click();
  } else if (event.key.toLowerCase() === "r") {
    resetViewButton.click();
  } else if (event.key.toLowerCase() === "f" && reviewMode === "transition" && !shootAction.disabled) {
    event.preventDefault();
    if (!event.repeat) shootAction.click();
  } else if (event.key.toLowerCase() === "s") {
    skeletonToggle.click();
  }
});
window.addEventListener("keyup", event => {
  if (event.code !== "Space") return;
  keyHeld = false;
  applyTestMovement();
});

const resize = () => {
  const width = window.innerWidth;
  const panel = document.querySelector<HTMLElement>(".info-panel")!;
  const transport = document.querySelector<HTMLElement>(".transport")!;
  const panelBottom = width <= 700 && getComputedStyle(panel).display !== "none" ? panel.getBoundingClientRect().bottom + 8 : 80;
  const top = Math.min(panelBottom, window.innerHeight * 0.3);
  const height = Math.max(80, transport.getBoundingClientRect().top - top - 12);
  canvas.style.top = `${top}px`;
  canvas.style.height = `${height}px`;
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
};
window.addEventListener("resize", resize);
const layoutObserver = new ResizeObserver(resize);
layoutObserver.observe(document.querySelector(".transport")!);
layoutObserver.observe(document.querySelector(".info-panel")!);
resize();

renderer.setAnimationLoop(() => {
  const delta = Math.min(clock.getDelta(), 0.05);
  if (reviewMode === "transition" && transitionController) {
    if (!transitionPaused) {
      if (autoEnabled) autoTime += delta * playbackSpeed;
      applyTestMovement();
      transitionController.update(delta * playbackSpeed);
    }
    updateTransitionDisplay();
  } else if (mixer && activeAction && activeClip && isPlaying && !isScrubbing) {
    mixer.update(delta * playbackSpeed);
    if (!loopToggle.checked && activeAction.time >= activeClip.duration) {
      isPlaying = false;
      updatePlayButton();
    }
  }
  if (heldWeapon) {
    const shootWeight = reviewMode === "transition"
      ? transitionController?.getSnapshot().actions.find(action => action.state === "shoot")?.weight ?? 0
      : activeClip?.name.toLowerCase() === "shoot" ? 1 : 0;
    heldWeapon.updatePose(shootWeight);
  }
  controls.update();
  updateTimeDisplay();
  renderer.render(scene, camera);
});

void loadModel(DEFAULT_MODEL_URL, DEFAULT_MODEL_NAME);
