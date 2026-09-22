import argparse
import json
import os
import sys

import bmesh
import bpy


def parse_args():
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    return parser.parse_args(values)


options = parse_args()
bpy.ops.wm.read_factory_settings(use_empty=True)
input_path = os.path.abspath(options.input)
if os.path.splitext(input_path)[1].lower() in {".glb", ".gltf"}:
    bpy.ops.import_scene.gltf(filepath=input_path)
else:
    bpy.ops.import_scene.fbx(filepath=input_path, automatic_bone_orientation=False)

mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
mesh = max(mesh_objects, key=lambda obj: len(obj.data.polygons))
editable = bmesh.new()
editable.from_mesh(mesh.data)
editable.edges.ensure_lookup_table()
boundary_edges = [edge for edge in editable.edges if len(edge.link_faces) == 1]
non_manifold_edges = [edge for edge in editable.edges if len(edge.link_faces) != 2]
coordinates = [mesh.matrix_world @ vertex.co for vertex in editable.verts]
minimum = [min(point[axis] for point in coordinates) for axis in range(3)]
maximum = [max(point[axis] for point in coordinates) for axis in range(3)]
height = maximum[2] - minimum[2]
head_cutoff = minimum[2] + height * 0.68
face_lower = minimum[2] + height * 0.66
face_upper = minimum[2] + height * 0.88
front_cutoff = (minimum[1] + maximum[1]) * 0.5
head_boundary_edges = [
    edge for edge in boundary_edges
    if all((mesh.matrix_world @ vertex.co).z >= head_cutoff for vertex in edge.verts)
]
face_boundary_edges = [
    edge for edge in boundary_edges
    if all(
        face_lower <= (mesh.matrix_world @ vertex.co).z <= face_upper
        and (mesh.matrix_world @ vertex.co).y <= front_cutoff
        for vertex in edge.verts
    )
]

adjacency = {}
for edge in boundary_edges:
    first, second = (vertex.index for vertex in edge.verts)
    adjacency.setdefault(first, set()).add(second)
    adjacency.setdefault(second, set()).add(first)

remaining = set(adjacency)
boundary_components = []
while remaining:
    start = remaining.pop()
    stack = [start]
    component = {start}
    while stack:
        vertex = stack.pop()
        for neighbor in adjacency.get(vertex, ()):
            if neighbor in remaining:
                remaining.remove(neighbor)
                component.add(neighbor)
                stack.append(neighbor)
    boundary_components.append(len(component))

editable.free()
images = [
    {
        "name": image.name,
        "width": image.size[0],
        "height": image.size[1],
    }
    for image in bpy.data.images
    if image.size[0] > 1 and image.size[1] > 1
]
report = {
    "input": input_path,
    "size_bytes": os.path.getsize(input_path),
    "mesh_objects": len(mesh_objects),
    "vertices": len(mesh.data.vertices),
    "polygons": len(mesh.data.polygons),
    "triangles": sum(max(0, len(polygon.vertices) - 2) for polygon in mesh.data.polygons),
    "bbox_min": [round(value, 6) for value in minimum],
    "bbox_max": [round(value, 6) for value in maximum],
    "boundary_edges": len(boundary_edges),
    "non_manifold_edges": len(non_manifold_edges),
    "head_boundary_edges": len(head_boundary_edges),
    "face_boundary_edges": len(face_boundary_edges),
    "boundary_components": len(boundary_components),
    "largest_boundary_components": sorted(boundary_components, reverse=True)[:10],
    "materials": [material.name for material in mesh.data.materials],
    "images": images,
    "armatures": len([obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]),
    "animations": [action.name for action in bpy.data.actions],
}
print("CHARACTER_MESH_REPORT=" + json.dumps(report, ensure_ascii=False))
