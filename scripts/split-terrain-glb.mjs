/**
 * Splits the authored assets-source/terrain2.glb into one GLB per object group,
 * written under public/Assets/terrain/ in a folder per object type.
 *
 * The split is a lossless subset of the source glTF JSON: buffer views are copied
 * byte-for-byte, so Draco-compressed primitives survive without a decode/encode
 * round trip. Every part keeps the source node names, which is what the runtime
 * looks objects up by after `loadTerrain` reassembles the parts under one root.
 *
 * Usage: node scripts/split-terrain-glb.mjs [--source <glb>] [--out <dir>] [--check]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const GLB_MAGIC = 0x46546c67;

/** Groups of source scene-root node names, one output GLB each. */
export const TERRAIN_PARTS = [
  { file: 'landscape/landscape.glb', roots: ['Landscape.002', 'Landscape.046'] },
  { file: 'structures/fence.glb', roots: ['fence6_Material_0.042'] },
  { file: 'structures/sketchfab-world.glb', roots: ['Sketchfab_model.003'] },
  { file: 'zones/zones.glb', roots: ['GreenZone', 'WhiteZone', 'YellowZone'] },
  { file: 'trees/tree1.glb', roots: ['Tree1_High', 'Tree1_Low'] },
  { file: 'trees/tree2.glb', roots: ['Tree2_High', 'Tree2_Low'] },
  { file: 'trees/tree3.glb', roots: ['Tree3_High', 'Tree3_Low'] },
  { file: 'trees/tree4.glb', roots: ['Tree4_High', 'Tree4_Low'] },
  { file: 'trees/tree5.glb', roots: ['Tree5_High', 'Tree5_Low'] },
  { file: 'trees/tree6.glb', roots: ['Tree6_High', 'Tree6_Low'] },
  { file: 'trees/tree7.glb', roots: ['Tree7_High', 'Tree7_Low'] },
  { file: 'trees/tree8.glb', roots: ['Tree8_High', 'Tree8_Low'] },
  { file: 'trees/tree9.glb', roots: ['Tree9_High', 'Tree9_Low'] },
  { file: 'props/stone.glb', roots: ['Stone'] },
  { file: 'props/lantern.glb', roots: ['Lantern'] },
  { file: 'colliders/colliders.glb', roots: ['WaterCollider', 'HouseCollider'] },
  { file: 'fauna/birds.glb', roots: ['Birds'] },
];

function parseGlb(buffer) {
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB file');
  let offset = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === JSON_CHUNK) json = JSON.parse(chunk.toString('utf8'));
    else if (type === BIN_CHUNK) bin = chunk;
    offset += 8 + length;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

function padTo4(length) {
  return (4 - (length % 4)) % 4;
}

function writeGlb(json, bin) {
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = Buffer.alloc(padTo4(jsonBuffer.length), 0x20);
  const binPad = Buffer.alloc(padTo4(bin.length), 0);
  const jsonLength = jsonBuffer.length + jsonPad.length;
  const binLength = bin.length + binPad.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonLength + (binLength ? 8 + binLength : 0), 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonLength, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4);
  const chunks = [header, jsonHeader, jsonBuffer, jsonPad];
  if (binLength) {
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binLength, 0);
    binHeader.writeUInt32LE(BIN_CHUNK, 4);
    chunks.push(binHeader, bin, binPad);
  }
  return Buffer.concat(chunks);
}

/** Walks a material and reports every texture reference (`{ index, texCoord }`) it holds. */
function collectTextureRefs(value, out) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const entry of value) collectTextureRefs(entry, out);
    return out;
  }
  if (typeof value.index === 'number' && !('bufferView' in value)) out.add(value.index);
  for (const entry of Object.values(value)) collectTextureRefs(entry, out);
  return out;
}

function collectExtensionNames(value, out) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const entry of value) collectExtensionNames(entry, out);
    return out;
  }
  if (value.extensions) for (const name of Object.keys(value.extensions)) out.add(name);
  for (const entry of Object.values(value)) collectExtensionNames(entry, out);
  return out;
}

export function subset(source, bin, rootNames) {
  const scene = source.scenes[source.scene ?? 0];
  const nodeIndexByName = new Map();
  source.nodes.forEach((node, index) => {
    if (node.name != null && !nodeIndexByName.has(node.name)) nodeIndexByName.set(node.name, index);
  });

  const roots = rootNames.map((name) => {
    const index = nodeIndexByName.get(name);
    if (index === undefined) throw new Error(`node "${name}" not found in source`);
    if (!scene.nodes.includes(index)) throw new Error(`node "${name}" is not a scene root`);
    return index;
  });

  // Nodes: the root subtrees, plus any skin joints/skeleton roots they reach.
  const nodes = new Set();
  const visitNode = (index) => {
    if (nodes.has(index)) return;
    nodes.add(index);
    for (const child of source.nodes[index].children ?? []) visitNode(child);
  };
  for (const root of roots) visitNode(root);

  const skins = new Set();
  let pending = true;
  while (pending) {
    pending = false;
    for (const index of [...nodes]) {
      const skinIndex = source.nodes[index].skin;
      if (skinIndex === undefined || skins.has(skinIndex)) continue;
      skins.add(skinIndex);
      const skin = source.skins[skinIndex];
      for (const joint of skin.joints) {
        if (nodes.has(joint)) continue;
        visitNode(joint);
        pending = true;
      }
      if (skin.skeleton !== undefined && !nodes.has(skin.skeleton)) {
        visitNode(skin.skeleton);
        pending = true;
      }
    }
  }

  const meshes = new Set();
  for (const index of nodes) {
    const mesh = source.nodes[index].mesh;
    if (mesh !== undefined) meshes.add(mesh);
  }

  const materials = new Set();
  const accessors = new Set();
  const bufferViews = new Set();
  for (const meshIndex of meshes) {
    for (const primitive of source.meshes[meshIndex].primitives) {
      if (primitive.material !== undefined) materials.add(primitive.material);
      const draco = primitive.extensions?.KHR_draco_mesh_compression;
      if (draco) bufferViews.add(draco.bufferView);
      for (const accessor of Object.values(primitive.attributes)) accessors.add(accessor);
      if (primitive.indices !== undefined) accessors.add(primitive.indices);
      for (const target of primitive.targets ?? []) {
        for (const accessor of Object.values(target)) accessors.add(accessor);
      }
    }
  }
  for (const skinIndex of skins) {
    const matrices = source.skins[skinIndex].inverseBindMatrices;
    if (matrices !== undefined) accessors.add(matrices);
  }

  // Animations: keep only the channels whose target node survived the subset.
  const animations = [];
  for (const animation of source.animations ?? []) {
    const samplerRemap = new Map();
    const samplers = [];
    const channels = [];
    for (const channel of animation.channels) {
      if (channel.target?.node === undefined || !nodes.has(channel.target.node)) continue;
      if (!samplerRemap.has(channel.sampler)) {
        samplerRemap.set(channel.sampler, samplers.length);
        samplers.push(animation.samplers[channel.sampler]);
      }
      channels.push({ ...channel, sampler: samplerRemap.get(channel.sampler) });
    }
    if (channels.length === 0) continue;
    for (const sampler of samplers) {
      accessors.add(sampler.input);
      accessors.add(sampler.output);
    }
    animations.push({ ...animation, channels, samplers });
  }

  const textures = new Set();
  for (const materialIndex of materials) collectTextureRefs(source.materials[materialIndex], textures);
  const images = new Set();
  const samplers = new Set();
  for (const textureIndex of textures) {
    const texture = source.textures[textureIndex];
    if (texture.source !== undefined) images.add(texture.source);
    if (texture.sampler !== undefined) samplers.add(texture.sampler);
  }

  for (const accessorIndex of accessors) {
    const accessor = source.accessors[accessorIndex];
    if (accessor.bufferView !== undefined) bufferViews.add(accessor.bufferView);
    const indices = accessor.sparse?.indices?.bufferView;
    const values = accessor.sparse?.values?.bufferView;
    if (indices !== undefined) bufferViews.add(indices);
    if (values !== undefined) bufferViews.add(values);
  }
  for (const imageIndex of images) {
    const view = source.images[imageIndex].bufferView;
    if (view !== undefined) bufferViews.add(view);
  }

  // Sorted index lists keep the output byte-identical across runs.
  const order = (set) => [...set].sort((a, b) => a - b);
  const remap = (list) => new Map(list.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  const nodeList = order(nodes);
  const meshList = order(meshes);
  const materialList = order(materials);
  const textureList = order(textures);
  const imageList = order(images);
  const samplerList = order(samplers);
  const accessorList = order(accessors);
  const skinList = order(skins);
  const viewList = order(bufferViews);
  const nodeMap = remap(nodeList);
  const meshMap = remap(meshList);
  const materialMap = remap(materialList);
  const textureMap = remap(textureList);
  const imageMap = remap(imageList);
  const samplerMap = remap(samplerList);
  const accessorMap = remap(accessorList);
  const skinMap = remap(skinList);
  const viewMap = remap(viewList);

  // Repack the binary chunk with only the surviving buffer views.
  const chunks = [];
  let cursor = 0;
  const newViews = viewList.map((viewIndex) => {
    const view = source.bufferViews[viewIndex];
    const start = view.byteOffset ?? 0;
    const bytes = bin.subarray(start, start + view.byteLength);
    const padding = padTo4(cursor);
    if (padding) {
      chunks.push(Buffer.alloc(padding, 0));
      cursor += padding;
    }
    const byteOffset = cursor;
    chunks.push(bytes);
    cursor += bytes.length;
    const next = { buffer: 0, byteOffset, byteLength: view.byteLength };
    if (view.byteStride !== undefined) next.byteStride = view.byteStride;
    if (view.target !== undefined) next.target = view.target;
    if (view.name !== undefined) next.name = view.name;
    return next;
  });
  const newBin = Buffer.concat(chunks);

  const mapTextureRefs = (value) => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(mapTextureRefs);
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = key === 'index' && typeof entry === 'number'
        ? textureMap.get(entry) ?? entry
        : mapTextureRefs(entry);
    }
    return next;
  };

  const output = {
    asset: source.asset,
    scene: 0,
    scenes: [{ name: scene.name, nodes: roots.map((index) => nodeMap.get(index)) }],
    nodes: nodeList.map((index) => {
      const node = { ...source.nodes[index] };
      if (node.children) node.children = node.children.map((child) => nodeMap.get(child));
      if (node.mesh !== undefined) node.mesh = meshMap.get(node.mesh);
      if (node.skin !== undefined) node.skin = skinMap.get(node.skin);
      delete node.camera;
      return node;
    }),
    meshes: meshList.map((index) => {
      const mesh = source.meshes[index];
      return {
        ...mesh,
        primitives: mesh.primitives.map((primitive) => {
          const next = { ...primitive };
          next.attributes = Object.fromEntries(
            Object.entries(primitive.attributes).map(([key, value]) => [key, accessorMap.get(value)]),
          );
          if (primitive.indices !== undefined) next.indices = accessorMap.get(primitive.indices);
          if (primitive.material !== undefined) next.material = materialMap.get(primitive.material);
          if (primitive.targets) {
            next.targets = primitive.targets.map((target) => Object.fromEntries(
              Object.entries(target).map(([key, value]) => [key, accessorMap.get(value)]),
            ));
          }
          const draco = primitive.extensions?.KHR_draco_mesh_compression;
          if (draco) {
            next.extensions = {
              ...primitive.extensions,
              KHR_draco_mesh_compression: { ...draco, bufferView: viewMap.get(draco.bufferView) },
            };
          }
          return next;
        }),
      };
    }),
    accessors: accessorList.map((index) => {
      const accessor = { ...source.accessors[index] };
      if (accessor.bufferView !== undefined) accessor.bufferView = viewMap.get(accessor.bufferView);
      if (accessor.sparse) {
        accessor.sparse = {
          ...accessor.sparse,
          indices: {
            ...accessor.sparse.indices,
            bufferView: viewMap.get(accessor.sparse.indices.bufferView),
          },
          values: {
            ...accessor.sparse.values,
            bufferView: viewMap.get(accessor.sparse.values.bufferView),
          },
        };
      }
      return accessor;
    }),
    materials: materialList.map((index) => mapTextureRefs(source.materials[index])),
    bufferViews: newViews,
    buffers: newBin.length ? [{ byteLength: newBin.length }] : [],
  };

  if (textureList.length) {
    output.textures = textureList.map((index) => {
      const texture = { ...source.textures[index] };
      if (texture.source !== undefined) texture.source = imageMap.get(texture.source);
      if (texture.sampler !== undefined) texture.sampler = samplerMap.get(texture.sampler);
      return texture;
    });
  }
  if (imageList.length) {
    output.images = imageList.map((index) => {
      const image = { ...source.images[index] };
      if (image.bufferView !== undefined) image.bufferView = viewMap.get(image.bufferView);
      return image;
    });
  }
  if (samplerList.length) output.samplers = samplerList.map((index) => source.samplers[index]);
  if (skinList.length) {
    output.skins = skinList.map((index) => {
      const skin = { ...source.skins[index] };
      skin.joints = skin.joints.map((joint) => nodeMap.get(joint));
      if (skin.skeleton !== undefined) skin.skeleton = nodeMap.get(skin.skeleton);
      if (skin.inverseBindMatrices !== undefined) {
        skin.inverseBindMatrices = accessorMap.get(skin.inverseBindMatrices);
      }
      return skin;
    });
  }
  if (animations.length) {
    output.animations = animations.map((animation) => ({
      ...animation,
      channels: animation.channels.map((channel) => ({
        ...channel,
        target: { ...channel.target, node: nodeMap.get(channel.target.node) },
      })),
      samplers: animation.samplers.map((sampler) => ({
        ...sampler,
        input: accessorMap.get(sampler.input),
        output: accessorMap.get(sampler.output),
      })),
    }));
  }

  const used = collectExtensionNames(output, new Set());
  const keep = (list) => (list ?? []).filter((name) => used.has(name));
  if (keep(source.extensionsUsed).length) output.extensionsUsed = keep(source.extensionsUsed);
  if (keep(source.extensionsRequired).length) output.extensionsRequired = keep(source.extensionsRequired);

  return {
    json: output,
    bin: newBin,
    stats: {
      nodes: nodeList.length,
      meshes: meshList.length,
      images: imageList.length,
      animations: animations.length,
    },
  };
}

function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args.set(argv[i].slice(2), next && !next.startsWith('--') ? next : true);
  }
  const sourcePath = typeof args.get('source') === 'string' ? args.get('source') : 'assets-source/terrain2.glb';
  const outDir = typeof args.get('out') === 'string' ? args.get('out') : 'public/Assets/terrain';
  const checkOnly = args.has('check');

  const sourceBuffer = readFileSync(sourcePath);
  const { json, bin } = parseGlb(sourceBuffer);
  const scene = json.scenes[json.scene ?? 0];
  const sceneRootNames = scene.nodes.map((index) => json.nodes[index].name);
  const covered = new Set(TERRAIN_PARTS.flatMap((part) => part.roots));
  const missed = sceneRootNames.filter((name) => !covered.has(name));
  if (missed.length) throw new Error(`scene roots not assigned to any part: ${missed.join(', ')}`);

  let total = 0;
  for (const part of TERRAIN_PARTS) {
    const { json: partJson, bin: partBin, stats } = subset(json, bin, part.roots);
    const glb = writeGlb(partJson, partBin);
    total += glb.length;
    if (!checkOnly) {
      const target = join(outDir, part.file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, glb);
    }
    const kb = (glb.length / 1024).toFixed(0).padStart(6);
    console.log(
      `${kb} KB  ${part.file.padEnd(30)} nodes=${stats.nodes} meshes=${stats.meshes}`
      + ` images=${stats.images} animations=${stats.animations}`,
    );
  }
  console.log(
    `\n${TERRAIN_PARTS.length} parts, ${(total / 1048576).toFixed(2)} MB total`
    + ` (source ${(sourceBuffer.length / 1048576).toFixed(2)} MB)`
    + `${checkOnly ? ' [check only, nothing written]' : ` -> ${relative(process.cwd(), outDir)}`}`,
  );
}

main(process.argv.slice(2));
