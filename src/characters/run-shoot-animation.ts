import * as THREE from "three";

const SAMPLE_FPS = 30;
const RECOIL_STRENGTH = 2;
const RECOIL_BONE = /mixamorig(?:Spine(?:1|2)?|(?:Left|Right)(?:Shoulder|Arm|ForeArm|Hand))\.(?:position|quaternion)$/i;

type SourceTrack = {
  track: THREE.KeyframeTrack;
  run: THREE.Interpolant;
  shoot?: THREE.Interpolant;
  shootStart?: number[];
};

/** Samples the current Run phase, then adds only Shoot motion relative to its first frame. */
export class RunShootClipFactory {
  readonly duration: number;
  private readonly runDuration: number;
  private readonly sources: SourceTrack[];
  private readonly times: number[];
  private readonly runRotation = new THREE.Quaternion();
  private readonly shootRotation = new THREE.Quaternion();
  private readonly recoilRotation = new THREE.Quaternion();

  constructor(run: THREE.AnimationClip, shoot: THREE.AnimationClip, duration: number) {
    if (!(run.duration > 0) || !(duration > 0 && duration < shoot.duration)) {
      throw new Error("RifleRunShoot requires a looping Run and a short Shoot pulse");
    }
    this.duration = duration;
    this.runDuration = run.duration;
    this.times = Array.from({ length: Math.round(duration * SAMPLE_FPS) + 1 }, (_, frame) =>
      Math.min(frame / SAMPLE_FPS, duration));
    const shootTracks = new Map(shoot.tracks.map(track => [track.name, track]));
    this.sources = run.tracks.filter(track => (
      track instanceof THREE.QuaternionKeyframeTrack || track instanceof THREE.VectorKeyframeTrack
    )).map(track => {
      const shootTrack = RECOIL_BONE.test(track.name) ? shootTracks.get(track.name) : undefined;
      const shootInterpolant = shootTrack?.InterpolantFactoryMethodLinear();
      return {
        track,
        run: track.InterpolantFactoryMethodLinear(),
        shoot: shootInterpolant,
        shootStart: shootInterpolant ? Array.from(shootInterpolant.evaluate(0)) : undefined,
      };
    });
  }

  createClip() {
    const tracks = this.sources.map(({ track }) => {
      const values = new Float32Array(this.times.length * track.getValueSize());
      if (track instanceof THREE.QuaternionKeyframeTrack) {
        return new THREE.QuaternionKeyframeTrack(track.name, this.times, values);
      }
      return new THREE.VectorKeyframeTrack(track.name, this.times, values);
    });
    const clip = new THREE.AnimationClip("RifleRunShoot", this.duration, tracks);
    this.populate(clip, 0, 1);
    return clip;
  }

  populate(clip: THREE.AnimationClip, runPhaseSeconds: number, runSpeedScale: number) {
    for (const [trackIndex, output] of clip.tracks.entries()) {
      const source = this.sources[trackIndex];
      const width = output.getValueSize();
      for (const [frame, time] of this.times.entries()) {
        const runTime = (runPhaseSeconds + runSpeedScale * time) % this.runDuration;
        const runValues = source.run.evaluate(runTime);
        const offset = frame * width;
        if (output instanceof THREE.QuaternionKeyframeTrack && source.shoot && source.shootStart) {
          this.runRotation.fromArray(runValues);
          this.shootRotation.fromArray(source.shoot.evaluate(time));
          this.recoilRotation.fromArray(source.shootStart).invert().multiply(this.shootRotation);
          // Two copies of the source rotation double the recoil angle during Run.
          this.recoilRotation.multiply(this.recoilRotation);
          this.runRotation.multiply(this.recoilRotation).normalize().toArray(output.values, offset);
        } else {
          const shootValues = source.shoot?.evaluate(time);
          for (let component = 0; component < width; component++) {
            output.values[offset + component] = runValues[component] + (shootValues && source.shootStart
              ? (shootValues[component] - source.shootStart[component]) * RECOIL_STRENGTH : 0);
          }
        }
      }
    }
  }
}
