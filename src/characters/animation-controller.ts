import * as THREE from "three";

export type CharacterLocomotionState = "idle" | "walk";
export type CharacterOneShotState = "shoot" | "attack" | "reload" | "melee" | "search" | "hit" | "death";
export type CharacterAnimationState = CharacterLocomotionState | CharacterOneShotState;
export type CharacterAnimationConfig = {
  clips: Partial<Record<CharacterAnimationState, string | RegExp>>;
  animationSpeed?: number;
  idlePose?: number;
  shootUpperBodyOnly?: boolean;
  shootPulseEndSeconds?: number;
};
export type CharacterActionPlaybackOptions = {
  restartIfActive?: boolean;
  durationSeconds?: number;
};

export const CHARACTER_TRANSITION_SECONDS = 0.12;
export const CHARACTER_ACTION_TRANSITION_SECONDS = 0.08;

const isLocomotionState = (state: CharacterAnimationState): state is CharacterLocomotionState => (
  state === "idle" || state === "walk"
);

const upperBodyClips = (root: THREE.Object3D, clips: THREE.AnimationClip[]) => {
  let spine: THREE.Bone | undefined;
  root.traverse(object => {
    if (object instanceof THREE.Bone && /Spine$/i.test(object.name) && /Hips$/i.test(object.parent?.name ?? "")) {
      spine = object;
    }
  });
  if (!spine) throw new Error("Upper-body Shoot requires a Spine bone parented to Hips");

  const upperBoneNames = new Set<string>();
  spine.traverse(object => { if (object instanceof THREE.Bone) upperBoneNames.add(object.name); });
  return clips.map(clip => new THREE.AnimationClip(
    clip.name,
    clip.duration,
    clip.tracks.filter(track => {
      const nodeName = THREE.PropertyBinding.parseTrackName(track.name).nodeName;
      return nodeName !== undefined && upperBoneNames.has(nodeName);
    }),
  ));
};

/** Shared by the game and the motion review page; no preview-only blending. */
export class CharacterAnimationController {
  private readonly mixer: THREE.AnimationMixer;
  private readonly locomotionLayer?: CharacterAnimationController;
  private readonly actions = new Map<CharacterAnimationState, THREE.AnimationAction>();
  private readonly allActions: THREE.AnimationAction[] = [];
  private readonly alternateShootAction?: THREE.AnimationAction;
  private readonly fromWeights = new Map<THREE.AnimationAction, number>();
  private lastShootAction?: THREE.AnimationAction;
  private activeAction?: THREE.AnimationAction;
  private state?: CharacterAnimationState;
  private locomotionState: CharacterLocomotionState = "idle";
  private oneShotState?: CharacterOneShotState;
  private elapsed = CHARACTER_TRANSITION_SECONDS;
  private transitionDuration = CHARACTER_TRANSITION_SECONDS;
  private readonly idlePose: number;
  private readonly animationSpeed: number;

  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[], config: CharacterAnimationConfig) {
    if (config.shootUpperBodyOnly) {
      if (!config.clips.idle || !config.clips.walk || !config.clips.shoot) {
        throw new Error("Upper-body Shoot requires Idle, Walk, and Shoot clips");
      }
      if (Object.keys(config.clips).some(state => !["idle", "walk", "shoot", "reload"].includes(state))) {
        throw new Error("Upper-body actions currently support Idle, Walk, Shoot, and Reload");
      }
      const maskedClips = upperBodyClips(root, clips);
      this.locomotionLayer = new CharacterAnimationController(root, clips, {
        ...config,
        clips: { idle: config.clips.idle, walk: config.clips.walk },
        shootUpperBodyOnly: false,
      });
      clips = maskedClips;
    }
    this.mixer = new THREE.AnimationMixer(root);
    this.idlePose = THREE.MathUtils.clamp(config.idlePose ?? 0.5, 0, 1);
    this.animationSpeed = config.animationSpeed ?? 1;
    for (const state of Object.keys(config.clips) as CharacterAnimationState[]) {
      const matcher = config.clips[state];
      const clip = clips.find(candidate => {
        if (typeof matcher === "string") return candidate.name.toLowerCase() === matcher.toLowerCase();
        if (!matcher) return false;
        matcher.lastIndex = 0;
        return matcher.test(candidate.name);
      });
      if (!clip) continue;
      if (state === "shoot" && config.shootPulseEndSeconds !== undefined && (
        !Number.isFinite(config.shootPulseEndSeconds)
        || config.shootPulseEndSeconds <= 0
        || config.shootPulseEndSeconds >= clip.duration
      )) throw new Error("Shoot pulse must end within the source Shoot clip");
      // The current Mixamo Shoot asset was sampled at 30 FPS. Its first recoil
      // peaks near frame 3; the second starts after the selected 0.30s window.
      const actionClip = state === "shoot" && config.shootPulseEndSeconds
        ? THREE.AnimationUtils.subclip(clip, clip.name, 0, Math.round(config.shootPulseEndSeconds * 30) + 1, 30)
        : clip;
      const action = this.mixer.clipAction(actionClip);
      action.timeScale = this.animationSpeed;
      action.setEffectiveWeight(0);
      this.actions.set(state, action);
      this.allActions.push(action);
      if (state === "shoot" && config.shootPulseEndSeconds) {
        // Separate clip identity lets consecutive shots blend instead of
        // snapping one still-weighted action back to its first frame.
        this.alternateShootAction = this.mixer.clipAction(actionClip.clone());
        this.alternateShootAction.timeScale = this.animationSpeed;
        this.alternateShootAction.setEffectiveWeight(0);
        this.allActions.push(this.alternateShootAction);
      }
    }
    if (!this.actions.size) throw new Error("Character contains none of the configured animation clips");
    if (this.actions.has("idle") || this.actions.has("walk")) this.activateLocomotion(true);
    else {
      const [state, action] = this.actions.entries().next().value!;
      this.activate(state, action, 0, true);
    }
    this.mixer.update(0);
  }

  setMovement(x: number, z: number) {
    this.setLocomotion(Math.hypot(x, z) > 0.08 ? "walk" : "idle");
  }

  setState(state: CharacterAnimationState) {
    if (isLocomotionState(state)) this.setLocomotion(state);
    else this.playOneShot(state as CharacterOneShotState);
  }

  setLocomotion(state: CharacterLocomotionState) {
    this.locomotionLayer?.setLocomotion(state);
    this.syncLocomotionPhase();
    if (state === this.locomotionState) return;
    this.locomotionState = state;
    // Movement remains current gameplay intent while a one-shot action owns the pose.
    if (!this.oneShotState) this.activateLocomotion(false);
  }

  playOneShot(state: CharacterOneShotState, options: CharacterActionPlaybackOptions = {}) {
    const primaryAction = this.actions.get(state);
    if (!primaryAction) return false;
    if (options.durationSeconds !== undefined && (
      !Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0
    )) throw new Error("One-shot duration must be positive and finite");
    // Automatic fire may arrive while the previous Shoot is still fading out.
    // Resetting that still-weighted clip to frame zero would snap the pose.
    if (options.restartIfActive === false && (
      this.oneShotState === state || primaryAction.getEffectiveWeight() > 1e-6
      || (state === "shoot" && (this.alternateShootAction?.getEffectiveWeight() ?? 0) > 1e-6)
    )) return false;

    const action = state === "shoot" && this.alternateShootAction && this.lastShootAction === primaryAction
      ? this.alternateShootAction : primaryAction;
    if (state === "shoot") this.lastShootAction = action;

    action.enabled = true;
    action.paused = false;
    action.timeScale = options.durationSeconds === undefined
      ? this.animationSpeed : action.getClip().duration / options.durationSeconds;
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.reset().play();
    this.oneShotState = state;

    if (action === this.activeAction) {
      // Rapid fire restarts time without creating a zero-weight frame.
      action.setEffectiveWeight(1);
      this.fromWeights.clear();
      this.elapsed = this.transitionDuration;
      this.state = state;
      this.mixer.update(0);
      return true;
    }

    this.activate(state, action, CHARACTER_ACTION_TRANSITION_SECONDS, false);
    return true;
  }

  stopOneShot(state: CharacterOneShotState) {
    if (this.oneShotState !== state) return false;
    this.oneShotState = undefined;
    this.activateLocomotion(false);
    return true;
  }

  update(delta: number) {
    if (!Number.isFinite(delta) || delta < 0) return;
    this.locomotionLayer?.update(delta);
    if (this.elapsed < this.transitionDuration) {
      this.elapsed = Math.min(this.transitionDuration, this.elapsed + delta);
      const alpha = this.transitionDuration <= 0 ? 1 : this.elapsed / this.transitionDuration;
      for (const action of this.allActions) {
        const weight = THREE.MathUtils.lerp(
          this.fromWeights.get(action) ?? 0,
          action === this.activeAction ? 1 : 0,
          alpha,
        );
        action.setEffectiveWeight(weight);
      }
    }
    this.mixer.update(delta);

    if (this.oneShotState && this.activeAction) {
      const duration = this.activeAction.getClip().duration;
      if (this.activeAction.time >= duration - 1e-6) {
        this.oneShotState = undefined;
        this.activateLocomotion(false);
      }
    }
    this.syncLocomotionPhase();
  }

  getSnapshot() {
    return {
      state: this.state,
      locomotionState: this.locomotionState,
      oneShotState: this.oneShotState,
      transitionDuration: this.transitionDuration,
      transitioning: this.elapsed < this.transitionDuration,
      actions: [...this.actions.entries()].map(([state, primary]) => {
        const alternate = state === "shoot" ? this.alternateShootAction : undefined;
        const action = alternate && this.lastShootAction ? this.lastShootAction : primary;
        return {
          state, name: primary.getClip().name, time: action.time,
          duration: primary.getClip().duration,
          weight: primary.getEffectiveWeight() + (alternate?.getEffectiveWeight() ?? 0),
        };
      }),
    };
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
    this.locomotionLayer?.dispose();
  }

  private activateLocomotion(immediate: boolean) {
    const frozenIdle = this.locomotionState === "idle" && !this.actions.has("idle");
    const state: CharacterAnimationState = frozenIdle ? "walk" : this.locomotionState;
    const action = this.actions.get(state);
    if (!action) return;

    action.enabled = true;
    action.play();
    action.paused = frozenIdle;
    if (frozenIdle) action.time = action.getClip().duration * this.idlePose;
    // The base layer owns Walk/Idle time. Never restart the masked upper-body
    // action when returning from Shoot: its arms must stay in phase with legs.
    this.activate(this.locomotionState, action, immediate ? 0 : CHARACTER_TRANSITION_SECONDS,
      !frozenIdle && !this.locomotionLayer);
  }

  private syncLocomotionPhase() {
    if (!this.locomotionLayer) return;
    let poseChanged = false;
    for (const state of ["idle", "walk"] as const) {
      const source = this.locomotionLayer.actions.get(state);
      const target = this.actions.get(state);
      if (source && target && Math.abs(target.time - source.time) > 1e-6) {
        target.time = source.time;
        poseChanged = poseChanged || target.getEffectiveWeight() > 1e-6;
      }
    }
    if (poseChanged) this.mixer.update(0);
  }

  private activate(
    state: CharacterAnimationState,
    action: THREE.AnimationAction,
    duration: number,
    resetIfInactive: boolean,
  ) {
    if (!this.activeAction) {
      for (const other of this.allActions) other.setEffectiveWeight(other === action ? 1 : 0);
      if (resetIfInactive && !action.paused) action.reset().play();
      action.setEffectiveWeight(1);
      this.elapsed = duration;
    } else if (action === this.activeAction) {
      action.setEffectiveWeight(1);
      this.elapsed = duration;
    } else {
      this.fromWeights.clear();
      for (const other of this.allActions) this.fromWeights.set(other, other.getEffectiveWeight());
      if (resetIfInactive && action.getEffectiveWeight() === 0) action.reset().play();
      action.setEffectiveWeight(this.fromWeights.get(action) ?? 0);
      this.elapsed = 0;
    }
    this.transitionDuration = duration;
    this.state = state;
    this.activeAction = action;
    this.mixer.update(0);
  }
}
