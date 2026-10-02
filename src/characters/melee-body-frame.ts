import * as THREE from "three";

/** Rebase the source upper-body pose onto the locomotion pelvis at the Spine boundary. */
export class MeleeBodyFrame {
  private readonly hips: THREE.Bone;
  private readonly spine: THREE.Bone;
  private readonly sourceRotations = new Map<string, THREE.Interpolant>();
  private readonly sourceRotation = new THREE.Quaternion();
  private readonly sampledRotation = new THREE.Quaternion();
  private readonly correction = new THREE.Quaternion();
  private readonly rawRotation = new THREE.Quaternion();
  private readonly rawPosition = new THREE.Vector3();
  private applied = false;

  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    let spine: THREE.Bone | undefined;
    root.traverse(node => {
      if (node instanceof THREE.Bone && /Spine$/i.test(node.name)
        && node.parent instanceof THREE.Bone && /Hips$/i.test(node.parent.name)) spine = node;
    });
    if (!spine) throw new Error("Moving melee requires Spine parented to Hips");
    this.spine = spine;
    this.hips = spine.parent as THREE.Bone;
    for (const clip of clips) {
      const track = clip.tracks.find(candidate => {
        const binding = THREE.PropertyBinding.parseTrackName(candidate.name);
        return binding.nodeName === this.hips.name && binding.propertyName === "quaternion";
      });
      if (track) this.sourceRotations.set(clip.name, track.InterpolantFactoryMethodLinear());
    }
  }

  restore() {
    if (!this.applied) return;
    // AnimationMixer may skip writing an unchanged property at delta=0. Restore
    // its uncorrected output first, so repeated evaluations cannot accumulate correction.
    this.spine.quaternion.copy(this.rawRotation);
    this.spine.position.copy(this.rawPosition);
    this.applied = false;
  }

  apply(actions: readonly THREE.AnimationAction[]) {
    let totalWeight = 0;
    for (const action of actions) {
      const weight = action.getEffectiveWeight();
      if (weight <= 0) continue;
      const source = this.sourceRotations.get(action.getClip().name);
      if (!source) throw new Error(`Missing source Hips rotation: ${action.getClip().name}`);
      this.sampledRotation.fromArray(source.evaluate(action.time)).normalize();
      totalWeight += weight;
      if (totalWeight === weight) this.sourceRotation.copy(this.sampledRotation);
      else this.sourceRotation.slerp(this.sampledRotation, weight / totalWeight);
    }
    if (totalWeight <= 0) return;
    this.rawRotation.copy(this.spine.quaternion);
    this.rawPosition.copy(this.spine.position);
    // The lower layer retains the gait pelvis. Express the original punch torso
    // in that pelvis's local frame, removing inherited gait tilt and counter-rotation.
    this.correction.copy(this.hips.quaternion).normalize().invert().multiply(this.sourceRotation).normalize();
    this.spine.quaternion.premultiply(this.correction);
    this.spine.position.applyQuaternion(this.correction);
    this.applied = true;
  }
}
