import * as THREE from "three";

export type CharacterAnimationState = "idle" | "walk" | "attack" | "hit" | "death";
export type CharacterAnimationConfig = {
  clips: Partial<Record<CharacterAnimationState, string | RegExp>>;
  animationSpeed?: number;
  idlePose?: number;
};

export const CHARACTER_TRANSITION_SECONDS = 0.12;

/** Shared by the game and the motion review page; no preview-only blending. */
export class CharacterAnimationController {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<CharacterAnimationState, THREE.AnimationAction>();
  private readonly fromWeights = new Map<THREE.AnimationAction, number>();
  private activeAction?: THREE.AnimationAction;
  private state?: CharacterAnimationState;
  private elapsed = CHARACTER_TRANSITION_SECONDS;
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
    this.setState(this.actions.has("idle") || this.actions.has("walk") ? "idle" : this.actions.keys().next().value!);
    this.mixer.update(0);
  }

  setMovement(x: number, z: number) {
    this.setState(Math.hypot(x, z) > 0.08 ? "walk" : "idle");
  }

  setState(state: CharacterAnimationState) {
    if (state === this.state) return;
    const frozenIdle = state === "idle" && !this.actions.has("idle");
    const action = this.actions.get(frozenIdle ? "walk" : state);
    if (!action) return;

    if (!this.activeAction || frozenIdle || action === this.activeAction) {
      // Initial pose must have full weight before model bounds are measured.
      // Legacy Walk-only monsters retain their frozen-pose Idle fallback.
      for (const other of this.actions.values()) {
        other.stopFading().setEffectiveWeight(other === action ? 1 : 0);
      }
      action.enabled = true;
      action.play();
      action.paused = frozenIdle;
      if (frozenIdle) action.time = action.getClip().duration * this.idlePose;
      this.elapsed = CHARACTER_TRANSITION_SECONDS;
    } else {
      this.fromWeights.clear();
      for (const other of this.actions.values()) {
        this.fromWeights.set(other, other.getEffectiveWeight());
      }
      // Reversing mid-blend must keep the contributing clip's time and weight.
      if (action.getEffectiveWeight() === 0) action.reset();
      action.enabled = true;
      action.paused = false;
      action.setEffectiveWeight(this.fromWeights.get(action) ?? 0).play();
      this.elapsed = 0;
    }
    this.state = state;
    this.activeAction = action;
    this.mixer.update(0);
  }

  update(delta: number) {
    if (!Number.isFinite(delta) || delta < 0) return;
    if (this.elapsed < CHARACTER_TRANSITION_SECONDS) {
      this.elapsed = Math.min(CHARACTER_TRANSITION_SECONDS, this.elapsed + delta);
      const alpha = this.elapsed / CHARACTER_TRANSITION_SECONDS;
      for (const action of this.actions.values()) {
        const weight = THREE.MathUtils.lerp(this.fromWeights.get(action) ?? 0, action === this.activeAction ? 1 : 0, alpha);
        action.setEffectiveWeight(weight);
      }
    }
    this.mixer.update(delta);
  }

  getSnapshot() {
    return {
      state: this.state,
      transitionDuration: CHARACTER_TRANSITION_SECONDS,
      transitioning: this.elapsed < CHARACTER_TRANSITION_SECONDS,
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
}
