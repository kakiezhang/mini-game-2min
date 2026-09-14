import argparse
import sys
from pathlib import Path

import bpy


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert character models with Blender.")
    parser.add_argument("mode", choices=("glb-to-fbx", "fbx-to-glb"))
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--animation-name", default="Walk")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])


def rename_actions(base_name: str) -> None:
    for index, action in enumerate(bpy.data.actions):
        action.name = base_name if index == 0 else f"{base_name}_{index + 1:02d}"


def main() -> None:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    if not input_path.is_file():
        raise SystemExit(f"Input model not found: {input_path}")
    if output_path.exists() and not args.force:
        raise SystemExit(f"Refusing to overwrite existing output: {output_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    if args.mode == "glb-to-fbx":
        bpy.ops.import_scene.gltf(filepath=str(input_path))
        bpy.ops.export_scene.fbx(
            filepath=str(output_path),
            use_selection=False,
            apply_unit_scale=True,
            apply_scale_options="FBX_SCALE_ALL",
            add_leaf_bones=False,
            bake_anim=False,
            path_mode="COPY",
            embed_textures=True,
        )
    else:
        bpy.ops.import_scene.fbx(filepath=str(input_path))
        rename_actions(args.animation_name)
        bpy.ops.export_scene.gltf(
            filepath=str(output_path),
            export_format="GLB",
            export_animations=True,
        )

    if not output_path.is_file() or output_path.stat().st_size == 0:
        raise SystemExit(f"Blender did not create a valid output file: {output_path}")
    print(f"Created {output_path} ({output_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
