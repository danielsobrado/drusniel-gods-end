"""Export .blend files to compressed GLB for the web build.

Run it through Blender, not Python:

  blender --background --factory-startup --python scripts/blend-to-glb.py -- <source-dir> <out-dir>

Each .blend in <source-dir> is baked down and written as <out-dir>/<name>.glb.

These scenes shade entirely through node graphs (brick, noise, wood, thatch) --
glTF carries none of that, so a plain export emits flat placeholder colours and
the buildings read as untextured blocks. Their modifier stacks also evaluate to
far more geometry than a game asset needs (a 1.2k-triangle tavern exports at
141k). So each file is: helpers stripped, modifiers evaluated, optionally
decimated to TARGET_TRIS, UV-unwrapped into one shared atlas, its albedo baked
while each piece is still its own object (the materials read per-object
properties), and then joined. The result is one material and a texture per
building instead of hundreds of flat-coloured primitives.

Options the running Blender does not expose are ignored, so the script survives
exporter revisions.
"""
import bpy
import os
import sys
import time

DRACO_LEVEL = 6
BAKE_SIZE = int(os.environ.get('BLEND_GLB_BAKE_SIZE', 2048))
# Decimation is opt-in. Collapsing these modifier stacks tears thin geometry --
# roof shingles, rails, planks -- into floating shards and see-through gaps, so
# the default keeps every evaluated triangle and only the draw calls and the
# texture change. Set BLEND_GLB_TARGET_TRIS to a triangle budget to enable it.
TARGET_TRIS = int(os.environ.get('BLEND_GLB_TARGET_TRIS', 0))

# Scene helpers that belong to the source scene, not the asset. The houses carry
# Blender ground-reflector planes (its reflection catcher) with a high emissive
# strength for the beauty renders; exported as-is they read as glowing panels.
# The residential house also stands on a round display plinth ('Piedestal')
# that reads as a dark disc sunk into the terrain.
HELPER_MATERIAL_PREFIXES = ('GROUND_REFLECTOR', 'Piedestal')


def strip_scene_helpers():
    """Remove objects made only of helper materials."""
    for obj in list(bpy.data.objects):
        if obj.type != 'MESH':
            continue
        materials = [slot.material for slot in obj.material_slots if slot.material]
        if not materials:
            continue
        if all(any(material.name == prefix or material.name.startswith(prefix)
                   for prefix in HELPER_MATERIAL_PREFIXES) for material in materials):
            bpy.data.objects.remove(obj, do_unlink=True)


# Object types the exporter itself turns into meshes. Curves are included on
# purpose: this kit uses them for ropes, rails and chains, and dropping them
# left the buildings visibly missing pieces.
GEOMETRY_TYPES = ('MESH', 'CURVE', 'SURFACE', 'FONT', 'META')


def visible_geometry():
    objects = []
    for obj in bpy.data.objects:
        if obj.type not in GEOMETRY_TYPES or obj.hide_render:
            continue
        try:
            if not obj.visible_get():
                continue
        except RuntimeError:
            pass
        objects.append(obj)
    return objects


def evaluated_copy(obj, depsgraph):
    """A static mesh copy that still shades like the original.

    The kit's materials read per-object custom properties through OBJECT
    Attribute nodes (brick colours, hue shifts, moss amounts) and use Object
    texture coordinates. A bare new object has neither the properties nor the
    transform, so bricks and wood baked black and pieces landed off position.
    """
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
    # Object-linked material slots are not in the mesh's own list.
    for index, slot in enumerate(obj.material_slots):
        if slot.link == 'OBJECT' and slot.material and index < len(mesh.materials):
            mesh.materials[index] = slot.material
    copy = bpy.data.objects.new(obj.name + '_baked', mesh)
    copy.matrix_world = obj.matrix_world.copy()
    for key in obj.keys():
        if key not in ('_RNA_UI', 'cycles', 'cycles_visibility'):
            copy[key] = obj[key]
    bpy.context.collection.objects.link(copy)
    return copy


def bake_down():
    """Evaluate modifiers, unwrap and bake per object, join, one material."""
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    # The colour pass is deterministic except where moss reads ambient
    # occlusion; one sample turned that into per-texel noise.
    scene.cycles.samples = 16
    scene.render.bake.use_pass_direct = False
    scene.render.bake.use_pass_indirect = False
    scene.render.bake.use_pass_color = True
    # A wide margin bleeds island colours into the packing gaps; without it the
    # black background shows through once the texture is minified at distance.
    scene.render.bake.margin = 16

    # Build the geometry the exporter would have shipped (evaluated meshes).
    # bpy.ops.object.convert hung on these modifier stacks; new_from_object does
    # not, and it is what the exporter itself uses.
    depsgraph = bpy.context.evaluated_depsgraph_get()
    original = visible_geometry()
    copies = []
    for obj in original:
        try:
            copy = evaluated_copy(obj, depsgraph)
        except Exception as exc:  # noqa: BLE001 - report and keep the rest
            print('EVAL FAIL\t%s\t%s' % (obj.name, exc))
            continue
        # Edge-only pieces (an unbevelled curve) draw nothing and stop the bake.
        if copy.data.polygons:
            copies.append(copy)
        else:
            bpy.data.objects.remove(copy, do_unlink=True)
    if not copies:
        return None
    # Drop every original object -- hidden meshes and curves alike -- so only the
    # evaluated copies are left to bake and export.
    keep = set(copies)
    for obj in [x for x in bpy.data.objects if x not in keep]:
        bpy.data.objects.remove(obj, do_unlink=True)

    # Decimate measures its ratio against triangles, and the meshes mix quads
    # and triangles, so count triangles rather than polygons.
    triangles = sum(len(polygon.vertices) - 2 for obj in copies for polygon in obj.data.polygons)
    if TARGET_TRIS > 0 and triangles > TARGET_TRIS:
        for obj in copies:
            decimate = obj.modifiers.new('Decimate', 'DECIMATE')
            decimate.decimate_type = 'COLLAPSE'
            decimate.ratio = TARGET_TRIS / triangles
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier=decimate.name)

    # Unwrap and bake while the pieces are still separate objects, so every
    # piece shades with its own properties and coordinates. Multi-object edit
    # mode packs all of them into one shared atlas.
    bpy.ops.object.select_all(action='DESELECT')
    for obj in copies:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = copies[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(island_margin=0.002)
    bpy.ops.object.mode_set(mode='OBJECT')

    image = bpy.data.images.new('BakedAlbedo', BAKE_SIZE, BAKE_SIZE)
    materials = {slot.material for obj in copies for slot in obj.material_slots if slot.material}
    for material in materials:
        material.use_nodes = True
        tree = material.node_tree
        node = tree.nodes.new('ShaderNodeTexImage')
        node.image = image
        tree.nodes.active = node
        node.select = True
    bpy.ops.object.bake(type='DIFFUSE')
    image.pack()

    if len(copies) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active

    baked = bpy.data.materials.new('BakedAlbedo')
    baked.use_nodes = True
    tree = baked.node_tree
    bsdf = tree.nodes.get('Principled BSDF')
    texture = tree.nodes.new('ShaderNodeTexImage')
    texture.image = image
    tree.links.new(texture.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.85
    bsdf.inputs['Metallic'].default_value = 0.0
    # Collapse everything onto the baked material: the joined mesh keeps both a
    # data-level material list and (sometimes) object-linked slots, and the
    # exporter reads whichever still carries the originals.
    joined.data.materials.clear()
    joined.data.materials.append(baked)
    for slot in joined.material_slots:
        slot.material = baked
    for polygon in joined.data.polygons:
        polygon.material_index = 0
    return joined


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    source, out = args[0], args[1]
    os.makedirs(out, exist_ok=True)

    options = {
        'export_format': 'GLB',
        'use_selection': False,
        'use_visible': True,
        # Modifiers are already evaluated into the joined mesh.
        'export_apply': False,
        'export_animations': False,
        'export_cameras': False,
        'export_lights': False,
        'export_extras': False,
        'export_yup': True,
        'export_tangents': False,
        'export_texcoords': True,
        'export_normals': True,
        'export_materials': 'EXPORT',
        'export_image_format': 'WEBP',
        'export_image_quality': 80,
        'export_draco_mesh_compression_enable': True,
        'export_draco_mesh_compression_level': DRACO_LEVEL,
        'export_draco_position_quantization': 14,
        'export_draco_normal_quantization': 10,
        'export_draco_texcoord_quantization': 12,
        'export_draco_generic_quantization': 12,
    }
    supported = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    kwargs = {key: value for key, value in options.items() if key in supported}

    for name in sorted(os.listdir(source)):
        if not name.lower().endswith('.blend'):
            continue
        started = time.time()
        bpy.ops.wm.open_mainfile(filepath=os.path.join(source, name))
        strip_scene_helpers()
        joined = bake_down()
        target = os.path.join(out, os.path.splitext(name)[0] + '.glb')
        result = bpy.ops.export_scene.gltf(filepath=target, **kwargs)
        size = os.path.getsize(target) if os.path.exists(target) else -1
        faces = len(joined.data.polygons) if joined else 0
        print('EXPORTED\t%s\t%d\tfaces=%d\t%.1fs\t%s'
              % (target, size, faces, time.time() - started, result))


main()
