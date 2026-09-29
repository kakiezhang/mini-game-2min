import * as THREE from "three";

const SAMPLE_FPS = 30;
const WALK_CYCLES = 3;
const JOG_DURATION = 0.95;
const RUN_POSE_WEIGHT = 0.5;
const ARM_BONE = /^mixamorig(?:Left|Right)(?:Shoulder|Arm|ForeArm|Hand)/i;
const TORSO_BONE = /^mixamorig(?:Spine|Neck|Head)/i;

/** One gait cycle with blended leg motion and a stable rifle grip. */
export function createRifleJogClip(walk: THREE.AnimationClip, run: THREE.AnimationClip) {
  const sampleCount = Math.round(JOG_DURATION * SAMPLE_FPS);
  const times = Array.from({ length: sampleCount + 1 }, (_, frame) =>
    Math.min(frame / sampleCount * JOG_DURATION, JOG_DURATION));
  const runTracks = new Map(run.tracks.map(track => [track.name, track]));
  const walkRotation = new THREE.Quaternion();
  const runRotation = new THREE.Quaternion();
  const tracks = walk.tracks.map(walkTrack => {
    const poseWeight = ARM_BONE.test(walkTrack.name) ? 0
      : TORSO_BONE.test(walkTrack.name) ? 0.25 : RUN_POSE_WEIGHT;
    const runTrack = runTracks.get(walkTrack.name);
    const walkSampler = walkTrack.InterpolantFactoryMethodLinear();
    const runSampler = runTrack?.InterpolantFactoryMethodLinear();
    const width = walkTrack.getValueSize();
    const values = new Float32Array(times.length * width);
    for (const [frame, time] of times.entries()) {
      const phase = (time / JOG_DURATION) % 1;
      const walkValues = walkSampler.evaluate(phase * walk.duration / WALK_CYCLES);
      const runValues = runSampler?.evaluate(phase * run.duration);
      const offset = frame * width;
      if (walkTrack instanceof THREE.QuaternionKeyframeTrack && runValues) {
        walkRotation.fromArray(walkValues);
        runRotation.fromArray(runValues);
        walkRotation.slerp(runRotation, poseWeight).normalize().toArray(values, offset);
      } else {
        for (let component = 0; component < width; component++) {
          values[offset + component] = runValues
            ? THREE.MathUtils.lerp(walkValues[component], runValues[component], poseWeight)
            : walkValues[component];
        }
      }
    }
    return walkTrack instanceof THREE.QuaternionKeyframeTrack
      ? new THREE.QuaternionKeyframeTrack(walkTrack.name, times, values)
      : new THREE.VectorKeyframeTrack(walkTrack.name, times, values);
  });
  return new THREE.AnimationClip("RifleJog", JOG_DURATION, tracks);
}
