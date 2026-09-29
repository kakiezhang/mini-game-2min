import * as THREE from "three";
import { createRifleJogClip } from "./jog-animation.js";
import { RunShootClipFactory } from "./run-shoot-animation.js";

export type CharacterLocomotionState = "idle" | "walk" | "jog" | "run";
export type CharacterOneShotState = "shoot" | "attack" | "reload" | "melee" | "search" | "hit" | "death";
export type CharacterAnimationState = CharacterLocomotionState | CharacterOneShotState;
export type CharacterAnimationConfig = {
  clips: Partial<Record<CharacterAnimationState, string | RegExp>>;
  animationSpeed?: number;
  idlePose?: number;
  shootUpperBodyOnly?: boolean;
  shootPulseEndSeconds?: number;
  walkCycleCount?: number;
  jogFromWalkRun?: boolean;
  runShootFromRun?: boolean;
};
export type CharacterActionPlaybackOptions = {
  restartIfActive?: boolean;
  durationSeconds?: number;
};

export const CHARACTER_TRANSITION_SECONDS = 0.12;
export const CHARACTER_ACTION_TRANSITION_SECONDS = 0.08;

const isLocomotionState = (state: CharacterAnimationState): state is CharacterLocomotionState => (
  state === "idle" || state === "walk" || state === "jog" || state === "run"
);

const findClip = (clips: THREE.AnimationClip[], matcher: string | RegExp | undefined) => clips.find(candidate => {
  if (typeof matcher === "string") return candidate.name.toLowerCase() === matcher.toLowerCase();
  if (!matcher) return false;
  matcher.lastIndex = 0;
  return matcher.test(candidate.name);
});

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
  private readonly runShootFactory?: RunShootClipFactory;
  private readonly runShootActions?: [THREE.AnimationAction, THREE.AnimationAction];
  private readonly fromWeights = new Map<THREE.AnimationAction, number>();
  private lastShootAction?: THREE.AnimationAction;
  private activeAction?: THREE.AnimationAction;
  private state?: CharacterAnimationState;
  private locomotionState: CharacterLocomotionState = "idle";
  private moving = false;
  private movementSpeedScale = 1;
  private oneShotState?: CharacterOneShotState;
  private elapsed = CHARACTER_TRANSITION_SECONDS;
  private transitionDuration = CHARACTER_TRANSITION_SECONDS;
  private readonly idlePose: number;
  private readonly animationSpeed: number;
  private readonly walkCycles: number;

  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[], config: CharacterAnimationConfig) {
    this.walkCycles = config.walkCycleCount ?? (config.jogFromWalkRun ? 3 : 1);
    if (config.jogFromWalkRun) {
      const walk = findClip(clips, config.clips.walk);
      const run = findClip(clips, config.clips.run);
      if (!walk || !run) throw new Error("RifleJog requires Walk and Run clips");
      clips = [...clips, createRifleJogClip(walk, run)];
      config = { ...config, clips: { ...config.clips, jog: /^RifleJog$/i } };
    }
    if (config.shootUpperBodyOnly) {
      if (!config.clips.idle || !config.clips.walk || !config.clips.shoot) {
        throw new Error("Upper-body Shoot requires Idle, Walk, and Shoot clips");
      }
      if (Object.keys(config.clips).some(state => !["idle", "walk", "jog", "run", "shoot", "reload"].includes(state))) {
        throw new Error("Upper-body actions currently support Idle, Walk, Jog, Run, Shoot, and Reload");
      }
      const maskedClips = upperBodyClips(root, clips);
      this.locomotionLayer = new CharacterAnimationController(root, clips, {
        ...config,
        clips: { idle: config.clips.idle, walk: config.clips.walk, jog: config.clips.jog, run: config.clips.run },
        shootUpperBodyOnly: false,
        walkCycleCount: this.walkCycles,
        jogFromWalkRun: false,
        runShootFromRun: false,
      });
      clips = maskedClips;
    }
    this.mixer = new THREE.AnimationMixer(root);
    this.idlePose = THREE.MathUtils.clamp(config.idlePose ?? 0.5, 0, 1);
    this.animationSpeed = config.animationSpeed ?? 1;
    for (const state of Object.keys(config.clips) as CharacterAnimationState[]) {
      const matcher = config.clips[state];
      const clip = findClip(clips, matcher);
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
    if (config.runShootFromRun) {
      const run = findClip(clips, config.clips.run);
      const shoot = findClip(clips, config.clips.shoot);
      if (!config.shootUpperBodyOnly || !run || !shoot || !config.shootPulseEndSeconds) {
        throw new Error("RifleRunShoot requires upper-body Shoot, Run, and a short Shoot pulse");
      }
      this.runShootFactory = new RunShootClipFactory(run, shoot, config.shootPulseEndSeconds);
      this.runShootActions = [this.runShootFactory.createClip(), this.runShootFactory.createClip()]
        .map(clip => {
          const action = this.mixer.clipAction(clip);
          action.timeScale = this.animationSpeed;
          action.setEffectiveWeight(0);
          this.allActions.push(action);
          return action;
        }) as [THREE.AnimationAction, THREE.AnimationAction];
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
    this.moving = Math.hypot(x, z) > 0.08;
    this.setLocomotion(this.moving ? this.movementLocomotion() : "idle");
  }

  setMovementSpeedScale(scale: number) {
    if (!Number.isFinite(scale) || scale <= 0) return;
    this.movementSpeedScale = THREE.MathUtils.clamp(scale, 0.2, 2);
    this.locomotionLayer?.setMovementSpeedScale(this.movementSpeedScale);
    for (const state of ["walk", "jog", "run"] as const) {
      const action = this.actions.get(state);
      if (action) action.timeScale = this.animationSpeed * this.movementSpeedScale;
    }
    if (this.moving) this.setLocomotion(this.movementLocomotion());
  }

  private movementLocomotion(): CharacterLocomotionState {
    if (this.actions.has("jog")) {
      const runThreshold = this.locomotionState === "run" ? 1.35 : 1.4;
      if (this.actions.has("run") && this.movementSpeedScale >= runThreshold) return "run";
      const jogThreshold = this.locomotionState === "jog" || this.locomotionState === "run" ? 1.04 : 1.08;
      return this.movementSpeedScale >= jogThreshold ? "jog" : "walk";
    }
    const threshold = this.locomotionState === "run" ? 1.06 : 1.16;
    return this.actions.has("run") && this.movementSpeedScale >= threshold ? "run" : "walk";
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
      || (state === "shoot" && (this.runShootActions?.some(action => action.getEffectiveWeight() > 1e-6) ?? false))
    )) return false;

    const runningShoot = state === "shoot" && this.runShootFactory !== undefined && this.runShootActions !== undefined
      && this.locomotionState === "run";
    const shootPair: [THREE.AnimationAction, THREE.AnimationAction | undefined] = runningShoot
      ? this.runShootActions! : [primaryAction, this.alternateShootAction];
    const action = state === "shoot" && shootPair[1] && this.lastShootAction === shootPair[0]
      ? shootPair[1] : shootPair[0];
    if (state === "shoot") {
      if (runningShoot) {
        const runPhase = this.locomotionLayer?.actions.get("run")?.time ?? 0;
        this.runShootFactory!.populate(action.getClip(), runPhase, this.movementSpeedScale);
      }
      this.lastShootAction = action;
    }

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
        const shootActions = state === "shoot"
          ? [primary, this.alternateShootAction, ...(this.runShootActions ?? [])].filter(
            (action): action is THREE.AnimationAction => action !== undefined)
          : [primary];
        const action = state === "shoot" && this.lastShootAction ? this.lastShootAction : primary;
        return {
          state, name: action.getClip().name, time: action.time,
          duration: action.getClip().duration,
          weight: shootActions.reduce((total, candidate) => total + candidate.getEffectiveWeight(), 0),
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

    const changingGait = this.state !== undefined && this.state !== "idle"
      && isLocomotionState(this.state) && state !== "idle" && state !== this.state;
    if (changingGait && this.activeAction) {
      const sourceCycles = this.state === "walk" ? this.walkCycles : 1;
      const targetCycles = state === "walk" ? this.walkCycles : 1;
      const phase = (this.activeAction.time / (this.activeAction.getClip().duration / sourceCycles)) % 1;
      action.time = phase * action.getClip().duration / targetCycles;
    }

    action.enabled = true;
    action.play();
    action.paused = frozenIdle;
    if (frozenIdle) action.time = action.getClip().duration * this.idlePose;
    // The base layer owns Walk/Idle time. Never restart the masked upper-body
    // action when returning from Shoot: its arms must stay in phase with legs.
    this.activate(this.locomotionState, action, immediate ? 0 : CHARACTER_TRANSITION_SECONDS,
      !frozenIdle && !this.locomotionLayer && !changingGait);
  }

  private syncLocomotionPhase() {
    if (!this.locomotionLayer) return;
    let poseChanged = false;
    for (const state of ["idle", "walk", "jog", "run"] as const) {
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
