import * as THREE from "three";

const THIGH_ROTATION = /^mixamorig(?:Left|Right)UpLeg\.quaternion$/i;

// Widen the swing around each clip's own neutral leg pose, keeping the
// character's original walk style and skeleton proportions intact.
export function widenWalkStride(source: THREE.AnimationClip, strideScale: number) {
  if (strideScale <= 1) return source;
  const clip = source.clone();

  for (const track of clip.tracks) {
    if (!(track instanceof THREE.QuaternionKeyframeTrack) || !THIGH_ROTATION.test(track.name)) continue;
    const values = track.values;
    const reference = new THREE.Quaternion().fromArray(values, 0);
    const pose = new THREE.Quaternion();
    const center = new THREE.Quaternion(0, 0, 0, 0);
    const widened = new THREE.Quaternion();

    for (let offset = 0; offset < values.length; offset += 4) {
      pose.fromArray(values, offset);
      const sign = pose.dot(reference) < 0 ? -1 : 1;
      center.set(
        center.x + pose.x * sign,
        center.y + pose.y * sign,
        center.z + pose.z * sign,
        center.w + pose.w * sign,
      );
    }
    center.normalize();

    for (let offset = 0; offset < values.length; offset += 4) {
      pose.fromArray(values, offset);
      widened.slerpQuaternions(center, pose, strideScale).normalize();
      values[offset] = widened.x;
      values[offset + 1] = widened.y;
      values[offset + 2] = widened.z;
      values[offset + 3] = widened.w;
    }
  }

  return clip;
}
