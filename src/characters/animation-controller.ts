import * as THREE from "three";

export type CharacterLocomotionState = "idle" | "walk";
export type CharacterOneShotState = "shoot" | "attack" | "reload" | "melee" | "search" | "hit" | "death";
export type CharacterAnimationState = CharacterLocomotionState | CharacterOneShotState;
export type CharacterAnimationConfig = {
  clips: Partial<Record<CharacterAnimationState, string | RegExp>>;
  animationSpeed?: number;
  idlePose?: number;
};

export const CHARACTER_TRANSITION_SECONDS = 0.12;
export const CHARACTER_ACTION_TRANSITION_SECONDS = 0.08;

const isLocomotionState = (state: CharacterAnimationState): state is CharacterLocomotionState => (
  state === "idle" || state === "walk"
);

/** Shared by the game and the motion review page; no preview-only blending. */
export class CharacterAnimationController {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<CharacterAnimationState, THREE.AnimationAction>();
  private readonly fromWeights = new Map<THREE.AnimationAction, number>();
  private activeAction?: THREE.AnimationAction;
  private state?: CharacterAnimationState;
  private locomotionState: CharacterLocomotionState = "idle";
  private oneShotState?: CharacterOneShotState;
  private elapsed = CHARACTER_TRANSITION_SECONDS;
  private transitionDuration = CHARACTER_TRANSITION_SECONDS;
  private readonly idlePose: number;

  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[], config: CharacterAnimationConfig) {
    this.mixer = new THREE.AnimationMixer(root);
    this.idlePose = THREE.MathUtils.clamp(config.idlePose ?? 0.5, 0, 1);
    for (const state of Object.keys(config.clips) as CharacterAnimationState[]) {
      const matcher = config.clips[state];
      const clip = clips.find(candidate => {
        if (typeof matcher === "string") return candidate.name.toLowerCase() === matcher.toLowerCase();
        if (!matcher) return false;
        matcher.lastIndex = 0;
        return matcher.test(candidate.name);
      });
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      action.timeScale = config.animationSpeed ?? 1;
      action.setEffectiveWeight(0);
      this.actions.set(state, action);
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
    if (state === this.locomotionState) return;
    this.locomotionState = state;
    // Movement remains current gameplay intent while a one-shot action owns the pose.
    if (!this.oneShotState) this.activateLocomotion(false);
  }

  playOneShot(state: CharacterOneShotState) {
    const action = this.actions.get(state);
    if (!action) return false;

    action.enabled = true;
    action.paused = false;
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

  update(delta: number) {
    if (!Number.isFinite(delta) || delta < 0) return;
    if (this.elapsed < this.transitionDuration) {
      this.elapsed = Math.min(this.transitionDuration, this.elapsed + delta);
      const alpha = this.transitionDuration <= 0 ? 1 : this.elapsed / this.transitionDuration;
      for (const action of this.actions.values()) {
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
  }

  getSnapshot() {
    return {
      state: this.state,
      locomotionState: this.locomotionState,
      oneShotState: this.oneShotState,
      transitionDuration: this.transitionDuration,
      transitioning: this.elapsed < this.transitionDuration,
      actions: [...this.actions.entries()].map(([state, action]) => ({
        state, name: action.getClip().name, time: action.time,
        duration: action.getClip().duration, weight: action.getEffectiveWeight(),
      })),
    };
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
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
    this.activate(this.locomotionState, action, immediate ? 0 : CHARACTER_TRANSITION_SECONDS, !frozenIdle);
  }

  private activate(
    state: CharacterAnimationState,
    action: THREE.AnimationAction,
    duration: number,
    resetIfInactive: boolean,
  ) {
    if (!this.activeAction) {
      for (const other of this.actions.values()) other.setEffectiveWeight(other === action ? 1 : 0);
      if (resetIfInactive && !action.paused) action.reset().play();
      action.setEffectiveWeight(1);
      this.elapsed = duration;
    } else if (action === this.activeAction) {
      action.setEffectiveWeight(1);
      this.elapsed = duration;
    } else {
      this.fromWeights.clear();
      for (const other of this.actions.values()) this.fromWeights.set(other, other.getEffectiveWeight());
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
