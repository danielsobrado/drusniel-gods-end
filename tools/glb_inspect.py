#!/usr/bin/env python3

from __future__ import annotations

import argparse
import io
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable

from PIL import Image
from pygltflib import GLTF2

BYTES_PER_COMPONENT = {
    5120: 1,  # BYTE
    5121: 1,  # UNSIGNED_BYTE
    5122: 2,  # SHORT
    5123: 2,  # UNSIGNED_SHORT
    5125: 4,  # UNSIGNED_INT
    5126: 4,  # FLOAT
}

COMPONENTS_PER_TYPE = {
    "SCALAR": 1,
    "VEC2": 2,
    "VEC3": 3,
    "VEC4": 4,
    "MAT2": 4,
    "MAT3": 9,
    "MAT4": 16,
}

GL_MODE_NAMES = {
    0: "POINTS",
    1: "LINES",
    2: "LINE_LOOP",
    3: "LINE_STRIP",
    4: "TRIANGLES",
    5: "TRIANGLE_STRIP",
    6: "TRIANGLE_FAN",
}


def human_bytes(value: int | None) -> str:
    if value is None:
        return "unknown"
    size = float(value)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.2f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{value} B"


def safe_name(value: str | None, fallback: str) -> str:
    return value if value else fallback


def load_image_bytes(gltf: GLTF2, path: Path, image_index: int) -> tuple[bytes | None, str]:
    image = gltf.images[image_index]

    if image.uri:
        if image.uri.startswith("data:"):
            try:
                return gltf.get_data_from_buffer_uri(image.uri), "embedded data URI"
            except Exception:
                return None, "embedded data URI"

        image_path = (path.parent / image.uri).resolve()
        try:
            return image_path.read_bytes(), f"external: {image.uri}"
        except OSError:
            return None, f"external missing: {image.uri}"

    if image.bufferView is None:
        return None, "no URI/bufferView"

    blob = gltf.binary_blob()
    if blob is None:
        return None, f"embedded bufferView {image.bufferView}"

    view = gltf.bufferViews[image.bufferView]
    start = view.byteOffset or 0
    end = start + view.byteLength
    return blob[start:end], f"embedded bufferView {image.bufferView}"


def image_info(data: bytes | None) -> tuple[str, str, str]:
    if not data:
        return "?x?", "unknown", "unknown"

    try:
        with Image.open(io.BytesIO(data)) as image:
            dimensions = f"{image.width}x{image.height}"
            image_format = image.format or "unknown"
            mode = image.mode or "unknown"
            return dimensions, image_format, mode
    except Exception:
        return "?x?", "unknown", "unknown"


def accessor_count(gltf: GLTF2, accessor_index: int | None) -> int:
    if accessor_index is None:
        return 0
    if accessor_index < 0 or accessor_index >= len(gltf.accessors):
        return 0
    return gltf.accessors[accessor_index].count or 0


def accessor_storage_bytes(gltf: GLTF2, accessor_index: int | None) -> int:
    if accessor_index is None or accessor_index < 0 or accessor_index >= len(gltf.accessors):
        return 0

    accessor = gltf.accessors[accessor_index]
    component_bytes = BYTES_PER_COMPONENT.get(accessor.componentType, 0)
    component_count = COMPONENTS_PER_TYPE.get(accessor.type, 0)
    return (accessor.count or 0) * component_bytes * component_count


def primitive_triangle_count(gltf: GLTF2, primitive) -> int:
    mode = primitive.mode if primitive.mode is not None else 4
    count = accessor_count(gltf, primitive.indices)
    if not count:
        count = accessor_count(gltf, getattr(primitive.attributes, "POSITION", None))

    if mode == 4:
        return count // 3
    if mode in (5, 6):
        return max(0, count - 2)
    return 0


def primitive_vertex_count(gltf: GLTF2, primitive) -> int:
    return accessor_count(gltf, getattr(primitive.attributes, "POSITION", None))


def iter_material_texture_slots(material) -> Iterable[tuple[str, int]]:
    pbr = material.pbrMetallicRoughness
    if pbr:
        if pbr.baseColorTexture is not None and pbr.baseColorTexture.index is not None:
            yield "baseColor", pbr.baseColorTexture.index
        if pbr.metallicRoughnessTexture is not None and pbr.metallicRoughnessTexture.index is not None:
            yield "metallicRoughness", pbr.metallicRoughnessTexture.index

    for slot_name, texture_info in (
        ("normal", material.normalTexture),
        ("occlusion", material.occlusionTexture),
        ("emissive", material.emissiveTexture),
    ):
        if texture_info is not None and texture_info.index is not None:
            yield slot_name, texture_info.index


def collect_material_usage(gltf: GLTF2) -> dict[int, list[str]]:
    usage: dict[int, list[str]] = defaultdict(list)
    for mesh_index, mesh in enumerate(gltf.meshes):
        for primitive_index, primitive in enumerate(mesh.primitives):
            if primitive.material is None:
                continue
            usage[primitive.material].append(
                f"mesh[{mesh_index}] {safe_name(mesh.name, '<unnamed>')} primitive[{primitive_index}]"
            )
    return usage


def print_summary(path: Path, gltf: GLTF2) -> None:
    primitive_count = sum(len(mesh.primitives) for mesh in gltf.meshes)
    total_vertices = sum(
        primitive_vertex_count(gltf, primitive)
        for mesh in gltf.meshes
        for primitive in mesh.primitives
    )
    total_triangles = sum(
        primitive_triangle_count(gltf, primitive)
        for mesh in gltf.meshes
        for primitive in mesh.primitives
    )

    print("FILE")
    print(f"  Path:         {path}")
    print(f"  Size:         {human_bytes(path.stat().st_size)}")
    print(f"  Format:       {path.suffix.lower().lstrip('.').upper()}")
    print()
    print("SCENE")
    print(f"  Scenes:       {len(gltf.scenes)}")
    print(f"  Nodes:        {len(gltf.nodes)}")
    print(f"  Meshes:       {len(gltf.meshes)}")
    print(f"  Primitives:   {primitive_count}")
    print(f"  Vertices*:    {total_vertices:,}")
    print(f"  Triangles*:   {total_triangles:,}")
    print(f"  Materials:    {len(gltf.materials)}")
    print(f"  Textures:     {len(gltf.textures)}")
    print(f"  Images:       {len(gltf.images)}")
    print(f"  Accessors:    {len(gltf.accessors)}")
    print(f"  BufferViews:  {len(gltf.bufferViews)}")
    print(f"  Buffers:      {len(gltf.buffers)}")
    print(f"  Animations:   {len(gltf.animations)}")
    print(f"  Skins:        {len(gltf.skins)}")
    print("  * Counts are summed per primitive; shared geometry can be counted more than once.")
    print()


def print_nodes(gltf: GLTF2) -> None:
    print("NODES")
    for index, node in enumerate(gltf.nodes):
        links = []
        if node.mesh is not None:
            links.append(f"mesh={node.mesh}")
        if node.skin is not None:
            links.append(f"skin={node.skin}")
        if node.camera is not None:
            links.append(f"camera={node.camera}")
        if node.children:
            links.append(f"children={len(node.children)}")
        suffix = f"  ({', '.join(links)})" if links else ""
        print(f"  [{index:>3}] {safe_name(node.name, '<unnamed>')}{suffix}")
    print()


def print_meshes(gltf: GLTF2) -> None:
    print("MESHES")
    for mesh_index, mesh in enumerate(gltf.meshes):
        print(f"  [{mesh_index}] {safe_name(mesh.name, '<unnamed>')}")
        for primitive_index, primitive in enumerate(mesh.primitives):
            mode = primitive.mode if primitive.mode is not None else 4
            material = primitive.material
            material_name = "none"
            if material is not None and 0 <= material < len(gltf.materials):
                material_name = f"{material}:{safe_name(gltf.materials[material].name, '<unnamed>')}"

            attributes = [
                name
                for name in (
                    "POSITION",
                    "NORMAL",
                    "TANGENT",
                    "TEXCOORD_0",
                    "TEXCOORD_1",
                    "COLOR_0",
                    "JOINTS_0",
                    "WEIGHTS_0",
                )
                if getattr(primitive.attributes, name, None) is not None
            ]
            vertices = primitive_vertex_count(gltf, primitive)
            triangles = primitive_triangle_count(gltf, primitive)
            approx_bytes = sum(
                accessor_storage_bytes(gltf, getattr(primitive.attributes, name, None))
                for name in attributes
            ) + accessor_storage_bytes(gltf, primitive.indices)

            print(
                f"    primitive[{primitive_index}] "
                f"mode={GL_MODE_NAMES.get(mode, str(mode))} "
                f"vertices={vertices:,} triangles={triangles:,} "
                f"material={material_name} approxGeometry={human_bytes(approx_bytes)}"
            )
            print(f"      attributes: {', '.join(attributes) if attributes else 'none'}")
    print()


def print_materials(gltf: GLTF2) -> None:
    usage = collect_material_usage(gltf)
    print("MATERIALS")
    for index, material in enumerate(gltf.materials):
        pbr = material.pbrMetallicRoughness
        metallic = pbr.metallicFactor if pbr and pbr.metallicFactor is not None else 1.0
        roughness = pbr.roughnessFactor if pbr and pbr.roughnessFactor is not None else 1.0
        slots = list(iter_material_texture_slots(material))
        slot_text = ", ".join(f"{slot}=texture[{texture_index}]" for slot, texture_index in slots) or "none"
        print(f"  [{index}] {safe_name(material.name, '<unnamed>')}")
        print(
            f"      alphaMode={material.alphaMode or 'OPAQUE'} "
            f"doubleSided={bool(material.doubleSided)} metallic={metallic} roughness={roughness}"
        )
        print(f"      textures: {slot_text}")
        if usage.get(index):
            print("      used by:")
            for item in usage[index]:
                print(f"        - {item}")
    print()


def print_textures_and_images(path: Path, gltf: GLTF2) -> None:
    texture_to_materials: dict[int, list[str]] = defaultdict(list)
    for material_index, material in enumerate(gltf.materials):
        material_name = safe_name(material.name, "<unnamed>")
        for slot, texture_index in iter_material_texture_slots(material):
            texture_to_materials[texture_index].append(f"material[{material_index}] {material_name} ({slot})")

    print("TEXTURES")
    for index, texture in enumerate(gltf.textures):
        source = texture.source
        sampler = texture.sampler
        name = safe_name(texture.name, "<unnamed>")
        print(f"  [{index}] {name} source=image[{source}] sampler={sampler if sampler is not None else 'default'}")
        for owner in texture_to_materials.get(index, []):
            print(f"      used by: {owner}")
    print()

    print("IMAGES")
    total_image_bytes = 0
    for index, image in enumerate(gltf.images):
        data, location = load_image_bytes(gltf, path, index)
        size = len(data) if data is not None else None
        if size is not None:
            total_image_bytes += size
        dimensions, image_format, mode = image_info(data)
        print(f"  [{index}] {safe_name(image.name, '<unnamed>')}")
        print(f"      {dimensions}  {image_format}  mode={mode}  {human_bytes(size)}")
        print(f"      mimeType={image.mimeType or 'unknown'}  {location}")
    print(f"  Total encoded image bytes: {human_bytes(total_image_bytes)}")
    print()


def print_buffers(gltf: GLTF2) -> None:
    print("BUFFERS")
    for index, buffer in enumerate(gltf.buffers):
        location = "embedded GLB BIN chunk" if not buffer.uri else buffer.uri
        print(f"  [{index}] declared={human_bytes(buffer.byteLength)}  {location}")
    print()


def print_animations(gltf: GLTF2) -> None:
    print("ANIMATIONS")
    if not gltf.animations:
        print("  none")
    for index, animation in enumerate(gltf.animations):
        targets = Counter()
        for channel in animation.channels:
            path = getattr(channel.target, "path", None) or "unknown"
            targets[path] += 1
        target_text = ", ".join(f"{name}={count}" for name, count in sorted(targets.items())) or "no channels"
        print(
            f"  [{index}] {safe_name(animation.name, '<unnamed>')} "
            f"channels={len(animation.channels)} samplers={len(animation.samplers)} ({target_text})"
        )
    print()


def print_extensions(gltf: GLTF2) -> None:
    print("EXTENSIONS")
    used = gltf.extensionsUsed or []
    required = set(gltf.extensionsRequired or [])
    if not used:
        print("  none")
    for extension in used:
        marker = " required" if extension in required else ""
        print(f"  - {extension}{marker}")
    print()


def inspect(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(path)
    if path.suffix.lower() not in {".glb", ".gltf"}:
        raise ValueError(f"Expected .glb or .gltf, got: {path.suffix or '<no extension>'}")

    gltf = GLTF2().load(str(path))
    print_summary(path, gltf)
    print_nodes(gltf)
    print_meshes(gltf)
    print_materials(gltf)
    print_textures_and_images(path, gltf)
    print_buffers(gltf)
    print_animations(gltf)
    print_extensions(gltf)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inspect glTF/GLB structure, geometry, materials, textures and embedded image sizes."
    )
    parser.add_argument("file", type=Path, help="Path to a .glb or .gltf file")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        inspect(args.file.expanduser().resolve())
        return 0
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"error: failed to inspect {args.file}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
