import argparse
import os
import sys

import bpy
from mathutils import Vector


def args():
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output_dir")
    parser.add_argument("--frame", type=int, default=9)
    parser.add_argument("--full-body", action="store_true")
    return parser.parse_args(values)


def point_camera(camera, target):
    camera.rotation_euler = ((target - camera.location).to_track_quat("-Z", "Y")).to_euler()


def create_material(name, color, emission=False):
    material = bpy.data.materials.new(name)
    material.diffuse_color = (*color, 1)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    if emission:
        shader = nodes.new("ShaderNodeEmission")
        shader.inputs["Color"].default_value = (*color, 1)
        shader.inputs["Strength"].default_value = 1
    else:
        shader = nodes.new("ShaderNodeBsdfPrincipled")
        shader.inputs["Base Color"].default_value = (*color, 1)
        shader.inputs["Roughness"].default_value = 0.82
    material.node_tree.links.new(shader.outputs[0], output.inputs["Surface"])
    return material


options = args()
os.makedirs(options.output_dir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
input_path = os.path.abspath(options.input)
if os.path.splitext(input_path)[1].lower() in {".glb", ".gltf"}:
    bpy.ops.import_scene.gltf(filepath=input_path)
else:
    bpy.ops.import_scene.fbx(filepath=input_path, automatic_bone_orientation=False)
scene = bpy.context.scene
scene.frame_set(options.frame)
mesh = max((obj for obj in scene.objects if obj.type == "MESH"), key=lambda obj: len(obj.data.vertices))
meshes = [obj for obj in scene.objects if obj.type == "MESH"]

for image in bpy.data.images:
    if image.size[0] <= 1 or image.size[1] <= 1:
        continue
    safe_name = "".join(character if character.isalnum() or character in "._-" else "_" for character in image.name)
    image.filepath_raw = os.path.join(options.output_dir, f"texture_{safe_name}.png")
    image.file_format = "PNG"
    image.save()

depsgraph = bpy.context.evaluated_depsgraph_get()
evaluated = mesh.evaluated_get(depsgraph)
evaluated_mesh = evaluated.to_mesh()
matrix = evaluated.matrix_world
points = [matrix @ vertex.co for vertex in evaluated_mesh.vertices]
evaluated.to_mesh_clear()
focus_points = points if options.full_body else [point for point in points if point.z > 0.86]
minimum = Vector((min(p.x for p in focus_points), min(p.y for p in focus_points), min(p.z for p in focus_points)))
maximum = Vector((max(p.x for p in focus_points), max(p.y for p in focus_points), max(p.z for p in focus_points)))
target = (minimum + maximum) * 0.5
if not options.full_body:
    target.z -= 0.02

scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 640
scene.render.resolution_y = 640
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new("DiagnosticWorld")
scene.world.color = (0.015, 0.018, 0.022)

camera_data = bpy.data.cameras.new("DiagnosticCamera")
camera = bpy.data.objects.new("DiagnosticCamera", camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
camera.data.type = "ORTHO"
camera.data.ortho_scale = (maximum.z - minimum.z) * 1.12 if options.full_body else 0.72

key_data = bpy.data.lights.new("Key", type="AREA")
key_data.energy = 900
key_data.size = 4
key = bpy.data.objects.new("Key", key_data)
scene.collection.objects.link(key)
key.location = target + Vector((-2.5, -3.0, 3.0))
point_camera(key, target)

original_materials = {
    obj.name: list(obj.data.materials)
    for obj in meshes
}
original_material_indices = {
    obj.name: [polygon.material_index for polygon in obj.data.polygons]
    for obj in meshes
}
clay = create_material("FaceDiagnosticClay", (0.72, 0.36, 0.22))
emission = create_material("FaceDiagnosticEmission", (0.9, 0.9, 0.9), emission=True)
views = {
    "front": Vector((0.0, -1.0, 0.02)),
    "right": Vector((-0.58, -0.82, 0.02)),
    "left": Vector((0.58, -0.82, 0.02)),
}

for mode in ("textured", "clay", "emission"):
    for render_mesh in meshes:
        render_mesh.data.materials.clear()
        if mode == "textured":
            for material in original_materials[render_mesh.name]:
                render_mesh.data.materials.append(material)
            for polygon, material_index in zip(
                render_mesh.data.polygons,
                original_material_indices[render_mesh.name],
            ):
                polygon.material_index = material_index
        else:
            render_mesh.data.materials.append(clay if mode == "clay" else emission)
            for polygon in render_mesh.data.polygons:
                polygon.material_index = 0
    for view_name, direction in views.items():
        camera.location = target + direction * 5
        point_camera(camera, target)
        scene.render.filepath = os.path.join(options.output_dir, f"{mode}_{view_name}.png")
        bpy.ops.render.render(write_still=True)

print("Rendered", options.output_dir)
