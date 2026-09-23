import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector


def parse_args() -> argparse.Namespace:
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(
        description="Merge Mixamo animation-only FBX files into one skinned GLB.",
    )
    parser.add_argument("base_fbx", help="FBX with the skinned mesh and base animation")
    parser.add_argument("output_glb")
    parser.add_argument("--base-animation-name", default="Walk")
    parser.add_argument(
        "--clip",
        action="append",
        default=[],
        metavar="NAME=FBX",
        help="Animation-only Mixamo FBX; repeat for additional clips",
    )
    parser.add_argument(
        "--clip-range",
        action="append",
        default=[],
        metavar="NAME=START:END",
        help="Keep only an inclusive source frame range for a clip",
    )
    parser.add_argument(
        "--clip-smooth",
        action="append",
        default=[],
        metavar="NAME=RADIUS",
        help="Smooth arm and hand rotations with the given frame radius",
    )
    parser.add_argument(
        "--clip-loop-blend",
        action="append",
        default=[],
        metavar="NAME=FRAMES",
        help="Blend the final frames back to the first pose for a clean loop",
    )
    parser.add_argument("--force", action="store_true")
    return parser.parse_args(values)


def parse_clip(value: str) -> tuple[str, Path]:
    name, separator, path = value.partition("=")
    if not separator or not name.strip() or not path.strip():
        raise SystemExit(f"Invalid --clip value {value!r}; expected NAME=FBX")
    return name.strip(), Path(path).expanduser().resolve()


def parse_named_range(value: str) -> tuple[str, tuple[int, int]]:
    name, separator, frame_range = value.partition("=")
    start_text, range_separator, end_text = frame_range.partition(":")
    if not separator or not range_separator:
        raise SystemExit(f"Invalid frame range {value!r}; expected NAME=START:END")
    start = int(start_text)
    end = int(end_text)
    if start > end:
        raise SystemExit(f"Invalid frame range {value!r}; START must be <= END")
    return name.strip(), (start, end)


def parse_named_int(value: str, label: str) -> tuple[str, int]:
    name, separator, number_text = value.partition("=")
    if not separator:
        raise SystemExit(f"Invalid {label} {value!r}; expected NAME=NUMBER")
    number = int(number_text)
    if number < 0:
        raise SystemExit(f"Invalid {label} {value!r}; NUMBER must be >= 0")
    return name.strip(), number


def import_fbx(path: Path) -> tuple[list[bpy.types.Object], list[bpy.types.Action]]:
    objects_before = set(bpy.data.objects)
    actions_before = set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=str(path), automatic_bone_orientation=False)
    return (
        [obj for obj in bpy.data.objects if obj not in objects_before],
        [action for action in bpy.data.actions if action not in actions_before],
    )


def single_armature(objects: list[bpy.types.Object], label: str) -> bpy.types.Object:
    armatures = [obj for obj in objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise SystemExit(f"{label} must contain exactly one armature; found {len(armatures)}")
    return armatures[0]


def active_action(armature: bpy.types.Object, label: str) -> bpy.types.Action:
    animation_data = armature.animation_data
    action = animation_data.action if animation_data else None
    if action is None:
        raise SystemExit(f"{label} does not contain an active animation action")
    return action


def bone_depth(pose_bone: bpy.types.PoseBone) -> int:
    depth = 0
    parent = pose_bone.parent
    while parent is not None:
        depth += 1
        parent = parent.parent
    return depth


def average_quaternions(values: list[Quaternion]) -> Quaternion:
    reference = values[0]
    total = Vector((0.0, 0.0, 0.0, 0.0))
    for value in values:
        sign = -1.0 if reference.dot(value) < 0 else 1.0
        total += Vector((value.w, value.x, value.y, value.z)) * sign
    result = Quaternion((total[0], total[1], total[2], total[3]))
    result.normalize()
    return result


def is_arm_or_hand_bone(name: str) -> bool:
    return any(part in name for part in ("Shoulder", "Arm", "ForeArm", "Hand"))


def bake_action_onto_armature(
    source_armature: bpy.types.Object,
    target_armature: bpy.types.Object,
    source_action: bpy.types.Action,
    action_name: str,
    frame_range: tuple[int, int] | None = None,
    smooth_radius: int = 0,
    loop_blend_frames: int = 0,
) -> bpy.types.Action:
    source_armature.animation_data.action = source_action
    if target_armature.animation_data is None:
        target_armature.animation_data_create()

    target_bones = sorted(target_armature.pose.bones, key=bone_depth)
    source_to_target = target_armature.matrix_world.inverted_safe() @ source_armature.matrix_world
    source_start = math.ceil(source_action.frame_range[0])
    source_end = math.floor(source_action.frame_range[1])
    if frame_range is not None:
        source_start = max(source_start, frame_range[0])
        source_end = min(source_end, frame_range[1])
    if source_start > source_end:
        raise SystemExit(f"Animation clip {action_name!r} has an empty selected frame range")

    # Do not assign PoseBone.matrix parent by parent: its setter reads evaluated
    # parent transforms, which may still belong to Walk or the previous frame.
    # Convert each source pose explicitly against its *same-frame* parent matrix.
    target_armature.animation_data.action = None
    for track in target_armature.animation_data.nla_tracks:
        track.mute = True
    for bone in target_bones:
        bone.matrix_basis = Matrix.Identity(4)
    samples = {
        bone.name: [] for bone in target_bones
    }
    reference_poses = []

    for source_frame in range(source_start, source_end + 1):
        bpy.context.scene.frame_set(source_frame)
        bpy.context.view_layer.update()
        desired = {
            bone.name: source_to_target @ source_armature.pose.bones[bone.name].matrix.copy()
            for bone in target_bones
        }
        reference_poses.append(desired)
        for target_bone in target_bones:
            parent = target_bone.parent
            parent_args = dict(
                parent_matrix=desired[parent.name],
                parent_matrix_local=parent.bone.matrix_local,
            ) if parent else {}
            basis = target_bone.bone.convert_local_to_pose(
                desired[target_bone.name], target_bone.bone.matrix_local,
                invert=True, **parent_args,
            )
            location, rotation, scale = basis.decompose()
            previous = samples[target_bone.name]
            if previous and previous[-1][1].dot(rotation) < 0:
                rotation.negate()
            samples[target_bone.name].append((location, rotation, scale))

    if smooth_radius > 0:
        for target_bone in target_bones:
            if not is_arm_or_hand_bone(target_bone.name):
                continue
            original = samples[target_bone.name]
            smoothed = []
            for index, (location, _rotation, scale) in enumerate(original):
                start = max(0, index - smooth_radius)
                end = min(len(original), index + smooth_radius + 1)
                rotation = average_quaternions([sample[1] for sample in original[start:end]])
                smoothed.append((location.copy(), rotation, scale.copy()))
            samples[target_bone.name] = smoothed

    sample_count = source_end - source_start + 1
    blend_count = min(loop_blend_frames, max(0, sample_count - 1))
    if blend_count > 0:
        for target_bone in target_bones:
            bone_samples = samples[target_bone.name]
            first_location, first_rotation, first_scale = bone_samples[0]
            for offset in range(blend_count):
                index = sample_count - blend_count + offset
                alpha = (offset + 1) / blend_count
                alpha = alpha * alpha * (3.0 - 2.0 * alpha)
                location, rotation, scale = bone_samples[index]
                bone_samples[index] = (
                    location.lerp(first_location, alpha),
                    rotation.slerp(first_rotation, alpha),
                    scale.lerp(first_scale, alpha),
                )

    baked_action = bpy.data.actions.new(action_name)
    baked_action.use_fake_user = True
    target_armature.animation_data.action = baked_action

    for index in range(sample_count):
        output_frame = index
        for target_bone in target_bones:
            location, rotation, scale = samples[target_bone.name][index]
            target_bone.rotation_mode = "QUATERNION"
            target_bone.location = location
            target_bone.rotation_quaternion = rotation
            target_bone.scale = scale
            target_bone.keyframe_insert("location", frame=output_frame, group=target_bone.name)
            target_bone.keyframe_insert("rotation_quaternion", frame=output_frame, group=target_bone.name)
            target_bone.keyframe_insert("scale", frame=output_frame, group=target_bone.name)

    # Sampled animation must interpolate linearly, without Bezier overshoot.
    for layer in baked_action.layers:
        for strip in layer.strips:
            for slot in baked_action.slots:
                bag = strip.channelbag(slot)
                if bag:
                    for curve in bag.fcurves:
                        for key in curve.keyframe_points:
                            key.interpolation = "LINEAR"

    max_matrix_error = 0.0
    max_position_error = 0.0
    for index, desired in enumerate(reference_poses):
        bpy.context.scene.frame_set(index)
        bpy.context.view_layer.update()
        for bone in target_bones:
            actual = bone.matrix
            expected = desired[bone.name]
            max_position_error = max(max_position_error, (actual.translation - expected.translation).length)
            max_matrix_error = max(max_matrix_error, max(
                abs(actual[row][col] - expected[row][col]) for row in range(4) for col in range(4)
            ))
    print("RETARGET_VALIDATION=" + json.dumps({
        "clip": action_name, "source_frames": [source_start, source_end],
        "output_frames": [0, sample_count - 1], "bones": len(target_bones),
        "max_matrix_error": max_matrix_error, "max_position_error": max_position_error,
    }))
    if smooth_radius == 0 and blend_count == 0 and max_matrix_error > 0.0001:
        raise SystemExit("Baked animation does not reproduce source bone poses")

    return baked_action


def main() -> None:
    args = parse_args()
    base_path = Path(args.base_fbx).expanduser().resolve()
    output_path = Path(args.output_glb).expanduser().resolve()
    clips = [parse_clip(value) for value in args.clip]
    clip_ranges = dict(parse_named_range(value) for value in args.clip_range)
    clip_smoothing = dict(parse_named_int(value, "clip smoothing") for value in args.clip_smooth)
    clip_loop_blends = dict(
        parse_named_int(value, "clip loop blend") for value in args.clip_loop_blend
    )

    for label, path in [("Base FBX", base_path), *[(name, path) for name, path in clips]]:
        if not path.is_file():
            raise SystemExit(f"{label} not found: {path}")
    if output_path.exists() and not args.force:
        raise SystemExit(f"Refusing to overwrite existing output: {output_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    requested_names = [args.base_animation_name, *(name for name, _ in clips)]
    if len(set(requested_names)) != len(requested_names):
        raise SystemExit("Animation names must be unique")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    base_objects, _base_actions = import_fbx(base_path)
    base_armature = single_armature(base_objects, "Base FBX")
    meshes = [obj for obj in base_objects if obj.type == "MESH"]
    if not meshes:
        raise SystemExit("Base FBX must contain a skinned mesh")

    base_action = active_action(base_armature, "Base FBX")
    base_action.name = args.base_animation_name
    base_action.use_fake_user = True
    base_bones = {bone.name for bone in base_armature.data.bones}
    animation_actions = [base_action]

    for clip_name, clip_path in clips:
        clip_objects, _clip_actions = import_fbx(clip_path)
        clip_meshes = [obj for obj in clip_objects if obj.type == "MESH"]
        if clip_meshes:
            raise SystemExit(
                f"Animation clip {clip_name!r} contains a mesh; download it from Mixamo Without Skin",
            )

        clip_armature = single_armature(clip_objects, f"Animation clip {clip_name!r}")
        clip_bones = {bone.name for bone in clip_armature.data.bones}
        if clip_bones != base_bones:
            missing = sorted(base_bones - clip_bones)
            extra = sorted(clip_bones - base_bones)
            raise SystemExit(
                f"Animation clip {clip_name!r} has incompatible bones; "
                f"missing={missing}, extra={extra}",
            )
        for bone in base_armature.data.bones:
            source_bone = clip_armature.data.bones[bone.name]
            target_parent = bone.parent.name if bone.parent else None
            source_parent = source_bone.parent.name if source_bone.parent else None
            if target_parent != source_parent:
                raise SystemExit(f"Incompatible parent for {bone.name}: {source_parent} != {target_parent}")

        source_action = active_action(clip_armature, f"Animation clip {clip_name!r}")
        action = bake_action_onto_armature(
            clip_armature,
            base_armature,
            source_action,
            clip_name,
            frame_range=clip_ranges.get(clip_name),
            smooth_radius=clip_smoothing.get(clip_name, 0),
            loop_blend_frames=clip_loop_blends.get(clip_name, 0),
        )
        animation_actions.append(action)

        for obj in clip_objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.actions.remove(source_action, do_unlink=True)

    bpy.context.view_layer.objects.active = base_armature
    base_armature.select_set(True)
    base_armature.animation_data.action = base_action

    bpy.ops.export_scene.gltf(
        filepath=str(output_path),
        export_format="GLB",
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_frame_range=False,
    )

    if not output_path.is_file() or output_path.stat().st_size == 0:
        raise SystemExit(f"Blender did not create a valid output file: {output_path}")

    report = ", ".join(
        f"{action.name} {action.frame_range[0]:.0f}-{action.frame_range[1]:.0f}"
        for action in animation_actions
    )
    print(f"Created {output_path} ({output_path.stat().st_size} bytes)")
    print(f"Animations: {report}")


if __name__ == "__main__":
    main()
