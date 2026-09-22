import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector


def parse_args():
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--analyze", action="store_true")
    return parser.parse_args(values)


def point_camera(camera, target):
    camera.rotation_euler = ((target - camera.location).to_track_quat("-Z", "Y")).to_euler()


def create_camera(scene, mesh):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh.evaluated_get(depsgraph)
    evaluated_mesh = evaluated.to_mesh()
    matrix = evaluated.matrix_world
    points = [matrix @ vertex.co for vertex in evaluated_mesh.vertices]
    evaluated.to_mesh_clear()
    face_points = [point for point in points if point.z > 0.86]
    minimum = Vector((min(p.x for p in face_points), min(p.y for p in face_points), min(p.z for p in face_points)))
    maximum = Vector((max(p.x for p in face_points), max(p.y for p in face_points), max(p.z for p in face_points)))
    target = (minimum + maximum) * 0.5
    target.z -= 0.02
    camera_data = bpy.data.cameras.new("FaceRepairCamera")
    camera = bpy.data.objects.new("FaceRepairCamera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 0.72
    camera.location = target + Vector((0.0, -1.0, 0.02)) * 5
    point_camera(camera, target)
    return camera


def pixel_ray(scene, camera, x, y, resolution=640):
    aspect = scene.render.resolution_x / scene.render.resolution_y
    local_x = (x / resolution - 0.5) * camera.data.ortho_scale * aspect
    local_y = (0.5 - y / resolution) * camera.data.ortho_scale
    origin = camera.matrix_world @ Vector((local_x, local_y, -camera.data.clip_start))
    direction = camera.matrix_world.to_quaternion() @ Vector((0, 0, -1))
    return origin, direction.normalized()


def raycast_pixel(scene, camera, x, y, resolution=640):
    origin, direction = pixel_ray(scene, camera, x, y, resolution)
    return scene.ray_cast(bpy.context.evaluated_depsgraph_get(), origin, direction)


def polygon_details(mesh, polygon_index):
    polygon = mesh.data.polygons[polygon_index]
    uv_data = mesh.data.uv_layers.active.data
    uvs = [uv_data[loop].uv[:] for loop in polygon.loop_indices]
    center = mesh.matrix_world @ polygon.center
    return {
        "polygon": polygon_index,
        "vertices": list(polygon.vertices),
        "center": [round(value, 7) for value in center],
        "uvs": [[round(value, 7) for value in uv] for uv in uvs],
        "uv_pixels": [[round(uv[0] * 4096, 2), round((1 - uv[1]) * 4096, 2)] for uv in uvs],
    }


def find_color_image():
    candidates = [image for image in bpy.data.images if image.size[0] > 1 and "normal" not in image.name.lower()]
    return max(candidates, key=lambda image: image.size[0] * image.size[1])


def sample_polygon_color(mesh, polygon_index, image):
    polygon = mesh.data.polygons[polygon_index]
    uv_data = mesh.data.uv_layers.active.data
    uvs = [uv_data[loop].uv for loop in polygon.loop_indices]
    uv = sum(uvs, Vector((0, 0))) / len(uvs)
    width, height = image.size[:]
    x = min(width - 1, max(0, int((uv.x % 1) * width)))
    y = min(height - 1, max(0, int((uv.y % 1) * height)))
    offset = (y * width + x) * 4
    color = image.pixels[offset : offset + 4]
    return {
        "uv": [round(uv.x, 7), round(uv.y, 7)],
        "uv_pixel": [x, height - 1 - y],
        "color": [round(value, 6) for value in color],
        "luminance": round(color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722, 6),
    }


def scan_box(scene, camera, mesh, bounds, step=2):
    x_min, y_min, x_max, y_max = bounds
    faces = set()
    misses = []
    for y in range(y_min, y_max + 1, step):
        for x in range(x_min, x_max + 1, step):
            result, _location, _normal, polygon_index, obj, _matrix = raycast_pixel(scene, camera, x, y)
            if result and obj == mesh:
                faces.add(polygon_index)
            else:
                misses.append([x, y])
    return sorted(faces), misses


def is_skin_color(color):
    red, green, blue = color[:3]
    return red > 0.42 and green > 0.20 and red > green * 1.25 and green > blue * 1.15


def fit_skin_plane(scene, camera, mesh, color_image, bounds):
    x_min, y_min, x_max, y_max = bounds
    locations = []
    normals = []
    polygon_indices = set()
    for y in range(y_min, y_max + 1, 2):
        for x in range(x_min, x_max + 1, 2):
            result, location, normal, polygon_index, obj, _matrix = raycast_pixel(scene, camera, x, y)
            if not result or obj != mesh:
                continue
            sample = sample_polygon_color(mesh, polygon_index, color_image)
            if not is_skin_color(sample["color"]):
                continue
            locations.append(location.copy())
            normals.append(normal.copy())
            polygon_indices.add(polygon_index)
    if len(locations) < 6:
        raise RuntimeError(f"Not enough skin samples to fit cheek plane for {bounds}: {len(locations)}")
    center = sum(locations, Vector()) / len(locations)
    normal = sum(normals, Vector()).normalized()
    if normal.dot(camera.location - center) < 0:
        normal.negate()
    return center, normal, sorted(polygon_indices)


def intersect_skin_plane(scene, camera, pixel, center, normal, inset=-0.001):
    origin, direction = pixel_ray(scene, camera, pixel[0], pixel[1])
    denominator = normal.dot(direction)
    if abs(denominator) < 1e-6:
        raise RuntimeError(f"Cheek patch ray is parallel to fitted plane at {pixel}")
    distance = normal.dot(center - origin) / denominator
    return origin + direction * distance - normal * inset


def world_to_head_rest(world_position, armature, head_bone, mesh):
    desired_armature_space = armature.matrix_world.inverted() @ world_position
    skin_matrix = head_bone.matrix @ head_bone.bone.matrix_local.inverted()
    rest_armature_space = skin_matrix.inverted() @ desired_armature_space
    rest_world = armature.matrix_world @ rest_armature_space
    return mesh.matrix_world.inverted() @ rest_world


def create_flat_material(name, color, roughness=0.72):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Base Color"].default_value = (*color, 1.0)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = 0.0
    material.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return material


def create_cheek_backing(scene, camera, mesh, color_image, repair_materials):
    armature = next(obj for obj in scene.objects if obj.type == "ARMATURE")
    head_bone = armature.pose.bones.get("mixamorig:Head")
    if head_bone is None:
        raise RuntimeError("mixamorig:Head bone not found")

    patches = {
        "character_right": {
            "view_direction": Vector((0.0, -1.0, 0.02)),
            "fit_bounds": (238, 475, 272, 524),
            "corners": [(247, 487), (262, 495), (257, 510), (248, 508)],
            "inset": -0.001,
        },
    }
    front_direction = Vector((0.0, -1.0, 0.02))
    face_target = camera.location - front_direction * 5
    vertices = []
    faces = []
    diagnostics = {}
    for label, patch in patches.items():
        camera.location = face_target + patch["view_direction"] * 5
        point_camera(camera, face_target)
        center, normal, source_faces = fit_skin_plane(scene, camera, mesh, color_image, patch["fit_bounds"])
        world_corners = [
            intersect_skin_plane(scene, camera, pixel, center, normal, inset=patch["inset"])
            for pixel in patch["corners"]
        ]
        offset = len(vertices)
        vertices.extend(world_to_head_rest(point, armature, head_bone, mesh) for point in world_corners)
        faces.extend([
            (offset, offset + 3, offset + 2),
            (offset, offset + 2, offset + 1),
        ])
        diagnostics[label] = {
            "center": [round(value, 7) for value in center],
            "normal": [round(value, 7) for value in normal],
            "skin_sample_faces": source_faces,
            "world_corners": [[round(value, 7) for value in point] for point in world_corners],
        }
    camera.location = face_target + front_direction * 5
    point_camera(camera, face_target)

    patch_mesh = bpy.data.meshes.new("ksman_v2_face_backing_mesh")
    patch_mesh.from_pydata(vertices, [], faces)
    patch_mesh.update(calc_edges=True)
    patch_object = bpy.data.objects.new("ksman_v2_face_backing", patch_mesh)
    scene.collection.objects.link(patch_object)
    patch_object.matrix_world = mesh.matrix_world.copy()
    for label in patches:
        patch_mesh.materials.append(repair_materials[label])
    for polygon in patch_mesh.polygons:
        polygon.material_index = polygon.index // 2

    uv_layer = patch_mesh.uv_layers.new(name="UVMap")
    clean_skin_uv = [
        Vector((0.0865, 0.3760)),
        Vector((0.0905, 0.3760)),
        Vector((0.0905, 0.3720)),
        Vector((0.0865, 0.3720)),
    ]
    for polygon in patch_mesh.polygons:
        for loop_index in polygon.loop_indices:
            vertex_index = patch_mesh.loops[loop_index].vertex_index % 4
            uv_layer.data[loop_index].uv = clean_skin_uv[vertex_index]

    head_group = patch_object.vertex_groups.new(name="mixamorig:Head")
    head_group.add(list(range(len(vertices))), 1.0, "REPLACE")
    modifier = patch_object.modifiers.new(name="Armature", type="ARMATURE")
    modifier.object = armature
    return patch_object, diagnostics


def relocate_polygon_uvs(mesh, polygon_indices, target_center):
    uv_data = mesh.data.uv_layers.active.data
    diagnostics = {}
    for polygon_index in polygon_indices:
        polygon = mesh.data.polygons[polygon_index]
        loop_indices = list(polygon.loop_indices)
        original = [uv_data[index].uv.copy() for index in loop_indices]
        center = sum(original, Vector((0, 0))) / len(original)
        delta = target_center - center
        for loop_index in loop_indices:
            uv_data[loop_index].uv += delta
        diagnostics[polygon_index] = {
            "original_center": [round(value, 7) for value in center],
            "new_center": [round(value, 7) for value in target_center],
        }
    return diagnostics


def assign_repair_material(mesh, polygon_indices, material):
    mesh.data.materials.append(material)
    material_index = len(mesh.data.materials) - 1
    for polygon_index in polygon_indices:
        mesh.data.polygons[polygon_index].material_index = material_index
    return material_index


def bind_face_region_to_head(mesh, seed_polygon_indices, rings=2):
    vertices = {
        vertex_index
        for polygon_index in seed_polygon_indices
        for vertex_index in mesh.data.polygons[polygon_index].vertices
    }
    polygons = list(mesh.data.polygons)
    for _ in range(rings):
        connected = [polygon for polygon in polygons if any(index in vertices for index in polygon.vertices)]
        vertices.update(index for polygon in connected for index in polygon.vertices)

    vertex_indices = sorted(vertices)
    for group in mesh.vertex_groups:
        group.remove(vertex_indices)
    head_group = mesh.vertex_groups.get("mixamorig:Head")
    if head_group is None:
        raise RuntimeError("mixamorig:Head vertex group not found")
    head_group.add(vertex_indices, 1.0, "REPLACE")
    return vertex_indices


options = parse_args()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=os.path.abspath(options.input), automatic_bone_orientation=False)
scene = bpy.context.scene
scene.render.resolution_x = 640
scene.render.resolution_y = 640
scene.frame_set(9)
mesh = max((obj for obj in scene.objects if obj.type == "MESH"), key=lambda obj: len(obj.data.vertices))
weight_repaired_vertices = bind_face_region_to_head(
    mesh,
    [16619, 16658, 16659, 16715, 16754],
)
scene.frame_set(9)
camera = create_camera(scene, mesh)
color_image = find_color_image()

sample_pixels = {
    "screen_left_cheek": [(250, 493), (254, 498), (251, 503), (255, 508)],
    "screen_right_cheek": [(397, 503), (395, 507), (390, 510), (400, 500)],
}
hits = {}
for label, pixels in sample_pixels.items():
    found = []
    for x, y in pixels:
        result, location, normal, polygon_index, obj, _matrix = raycast_pixel(scene, camera, x, y)
        found.append({
            "pixel": [x, y],
            "hit": result,
            "object": obj.name if obj else None,
            "location": [round(value, 7) for value in location] if result else None,
            "normal": [round(value, 7) for value in normal] if result else None,
            "details": polygon_details(mesh, polygon_index) if result and obj == mesh else None,
        })
    hits[label] = found

box_results = {}
for label, bounds in {
    "screen_left_cheek": (232, 482, 270, 522),
    "screen_right_cheek": (372, 488, 405, 528),
}.items():
    faces, misses = scan_box(scene, camera, mesh, bounds)
    box_results[label] = {
        "bounds": bounds,
        "face_count": len(faces),
        "miss_count": len(misses),
        "misses": misses,
        "faces": [{**polygon_details(mesh, index), **sample_polygon_color(mesh, index, color_image)} for index in faces],
    }

front_direction = Vector((0.0, -1.0, 0.02))
face_target = camera.location - front_direction * 5
camera.location = face_target + Vector((0.58, -0.82, 0.02)) * 5
point_camera(camera, face_target)
side_samples = []
for x, y in [(347, 494), (343, 513), (350, 500), (340, 507)]:
    result, location, normal, polygon_index, obj, _matrix = raycast_pixel(scene, camera, x, y)
    side_samples.append({
        "pixel": [x, y],
        "hit": result,
        "object": obj.name if obj else None,
        "location": [round(value, 7) for value in location] if result else None,
        "normal": [round(value, 7) for value in normal] if result else None,
        "details": polygon_details(mesh, polygon_index) if result and obj == mesh else None,
    })
side_faces, side_misses = scan_box(scene, camera, mesh, (330, 484, 358, 528), step=1)
side_box = {
    "bounds": [330, 484, 358, 528],
    "miss_count": len(side_misses),
    "faces": [
        {**polygon_details(mesh, index), **sample_polygon_color(mesh, index, color_image)}
        for index in side_faces
    ],
}
camera.location = face_target + front_direction * 5
point_camera(camera, face_target)

if options.analyze:
    report = {
        "samples": hits,
        "side_samples": side_samples,
        "side_box": side_box,
        "boxes": box_results,
    }
    report_path = os.path.abspath(options.output)
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    summary = {
        label: {
            "face_count": value["face_count"],
            "miss_count": value["miss_count"],
            "dark_faces": [face["polygon"] for face in value["faces"] if face["luminance"] < 0.12],
            "skin_faces": [face["polygon"] for face in value["faces"] if face["color"][0] > 0.55 and face["color"][1] > 0.25],
        }
        for label, value in box_results.items()
    }
    print("FACE_REPAIR_REPORT=" + report_path)
    print("FACE_REPAIR_SUMMARY=" + json.dumps(summary, ensure_ascii=False))
    raise SystemExit(0)

output_path = os.path.abspath(options.output)
if os.path.exists(output_path):
    raise RuntimeError(f"Refusing to overwrite existing output: {output_path}")

repair_material = create_flat_material(
    "ksman_v2_face_repair_skin",
    (0.896, 0.402, 0.216),
)
patch_object, diagnostics = create_cheek_backing(
    scene,
    camera,
    mesh,
    color_image,
    {
        "character_right": repair_material,
    },
)
repaired_polygons = [42303, 47742, 48457]
diagnostics["repair_material_index"] = assign_repair_material(mesh, repaired_polygons, repair_material)
diagnostics["repair_material_polygons"] = repaired_polygons
diagnostics["weight_repaired_vertices"] = weight_repaired_vertices
bpy.data.objects.remove(camera, do_unlink=True)
scene.frame_set(1)
for index, action in enumerate(bpy.data.actions):
    action.name = "Walk" if index == 0 else f"Walk_{index + 1:02d}"
bpy.ops.export_scene.fbx(
    filepath=output_path,
    use_selection=False,
    apply_unit_scale=True,
    apply_scale_options="FBX_SCALE_ALL",
    add_leaf_bones=False,
    bake_anim=True,
    bake_anim_use_all_bones=True,
    bake_anim_use_all_actions=True,
    bake_anim_force_startend_keying=True,
    bake_anim_step=1.0,
    bake_anim_simplify_factor=0.0,
    path_mode="COPY",
    embed_textures=True,
)
if not os.path.isfile(output_path) or os.path.getsize(output_path) == 0:
    raise RuntimeError(f"Failed to create repaired FBX: {output_path}")
print("FACE_REPAIR_RESULT=" + json.dumps({
    "output": output_path,
    "size": os.path.getsize(output_path),
    "patch_object": patch_object.name,
    "patch_vertices": len(patch_object.data.vertices),
    "patch_faces": len(patch_object.data.polygons),
    "diagnostics": diagnostics,
}, ensure_ascii=False))
