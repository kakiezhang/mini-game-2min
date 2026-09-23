import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  CharacterAnimationController,
  type CharacterActionPlaybackOptions,
  type CharacterAnimationState,
  type CharacterOneShotState,
} from "./animation-controller.js";

export type { CharacterAnimationState } from "./animation-controller.js";

export type CharacterModelConfig = {
  url: string;
  height: number;
  facingOffset?: number;
  animationSpeed?: number;
  idlePose?: number;
  shootUpperBodyOnly?: boolean;
  shootPulseEndSeconds?: number;
  clips: Partial<Record<CharacterAnimationState, string | RegExp>>;
};

export type CharacterInstanceOptions = {
  maxAnisotropy?: number;
};

export interface CharacterVisual {
  readonly root: THREE.Group;
  setMovement(directionX: number, directionZ: number): void;
  setState(state: CharacterAnimationState): void;
  playOneShot(state: CharacterOneShotState, options?: CharacterActionPlaybackOptions): boolean;
  stopOneShot(state: CharacterOneShotState): boolean;
  update(delta: number): void;
  dispose(): void;
}

const DEFAULT_TURN_SPEED = Math.PI * 3;

export function turnCharacterTowardMovement(
  root: THREE.Object3D,
  directionX: number,
  directionZ: number,
  delta: number,
  turnSpeed = DEFAULT_TURN_SPEED,
) {
  if (Math.hypot(directionX, directionZ) <= 0.08) return;

  const targetRotation = Math.atan2(directionX, directionZ);
  const rotationDelta = Math.atan2(
    Math.sin(targetRotation - root.rotation.y),
    Math.cos(targetRotation - root.rotation.y),
  );
  const maximumStep = Math.max(0, delta) * turnSpeed;
  root.rotation.y += THREE.MathUtils.clamp(rotationDelta, -maximumStep, maximumStep);
}

export class StaticCharacterVisual implements CharacterVisual {
  constructor(readonly root = new THREE.Group()) {}

  setMovement(_directionX: number, _directionZ: number) {}

  setState(_state: CharacterAnimationState) {}

  playOneShot(_state: CharacterOneShotState, _options?: CharacterActionPlaybackOptions) { return false; }

  stopOneShot(_state: CharacterOneShotState) { return false; }

  update(_delta: number) {}

  dispose() {}
}

type CharacterAsset = {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
};

function cloneInstanceMaterial(material: THREE.Material) {
  const instanceMaterial = material.clone();
  instanceMaterial.userData = { ...material.userData };
  return instanceMaterial;
}

function prepareModel(model: THREE.Group, maxAnisotropy: number) {
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;

    // Geometry and textures stay shared between instances. Materials are cloned
    // so per-character effects (for example hit flashes) remain independent.
    object.geometry.userData.shared = true;
    object.material = Array.isArray(object.material)
      ? object.material.map(cloneInstanceMaterial)
      : cloneInstanceMaterial(object.material);
    object.castShadow = true;
    object.receiveShadow = true;
    object.frustumCulled = false;

    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      material.envMapIntensity = 0.7;
      if (material.map) material.map.anisotropy = Math.min(8, maxAnisotropy);
    }
  });
}

export class AnimatedCharacter implements CharacterVisual {
  readonly root: THREE.Group;

  private readonly animation: CharacterAnimationController;

  constructor(asset: CharacterAsset, config: CharacterModelConfig, options: CharacterInstanceOptions = {}) {
    this.root = cloneSkeleton(asset.scene) as THREE.Group;
    this.root.rotation.y = config.facingOffset ?? 0;
    prepareModel(this.root, options.maxAnisotropy ?? 1);

    // Apply an animation pose before measuring. Some Mixamo exports have a
    // different bind-pose up axis that resolves correctly only after evaluation.
    this.animation = new CharacterAnimationController(this.root, asset.animations, config);
    this.normalizeModel(config.height);
  }

  setState(state: CharacterAnimationState) {
    this.animation.setState(state);
  }

  playOneShot(state: CharacterOneShotState, options?: CharacterActionPlaybackOptions) {
    return this.animation.playOneShot(state, options);
  }

  stopOneShot(state: CharacterOneShotState) {
    return this.animation.stopOneShot(state);
  }

  setMovement(directionX: number, directionZ: number) {
    this.animation.setMovement(directionX, directionZ);
  }

  update(delta: number) {
    this.animation.update(delta);
  }

  dispose() {
    this.animation.dispose();
  }

  private normalizeModel(targetHeight: number) {
    this.root.updateMatrixWorld(true);
    const sourceBounds = new THREE.Box3().setFromObject(this.root);
    const sourceHeight = sourceBounds.getSize(new THREE.Vector3()).y;
    if (!Number.isFinite(sourceHeight) || sourceHeight <= 0) {
      throw new Error("Character model has invalid bounds");
    }

    this.root.scale.setScalar(targetHeight / sourceHeight);
    this.root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.root);
    const center = bounds.getCenter(new THREE.Vector3());
    this.root.position.x -= center.x;
    this.root.position.y -= bounds.min.y;
    this.root.position.z -= center.z;
  }
}

export class CharacterAssetStore {
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly pending = new Map<string, Promise<CharacterAsset>>();
  private readonly loaded = new Map<string, CharacterAsset>();

  preload(config: CharacterModelConfig) {
    return this.load(config).then(() => undefined);
  }

  create(config: CharacterModelConfig, options?: CharacterInstanceOptions) {
    const asset = this.loaded.get(config.url);
    if (!asset) throw new Error(`Character model was not preloaded: ${config.url}`);
    return new AnimatedCharacter(asset, config, options);
  }

  async createAsync(config: CharacterModelConfig, options?: CharacterInstanceOptions) {
    await this.preload(config);
    return this.create(config, options);
  }

  private load(config: CharacterModelConfig) {
    const loaded = this.loaded.get(config.url);
    if (loaded) return Promise.resolve(loaded);

    const pending = this.pending.get(config.url);
    if (pending) return pending;

    const request = this.loader.loadAsync(config.url)
      .then((gltf: GLTF) => {
        const asset = { scene: gltf.scene, animations: gltf.animations };
        this.loaded.set(config.url, asset);
        this.pending.delete(config.url);
        return asset;
      })
      .catch((error: unknown) => {
        this.pending.delete(config.url);
        throw error;
      });
    this.pending.set(config.url, request);
    return request;
  }
}
