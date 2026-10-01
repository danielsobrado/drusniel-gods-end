/** Offline derivatives of the shipped forest/alpine/jungle assets; originals remain untouched. */
import { NodeIO, Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  cloneDocument,
  compactPrimitive,
  dedup,
  draco,
  mergeDocuments,
  prune,
  simplifyPrimitive,
  textureCompress,
  unpartition,
  weld,
} from '@gltf-transform/functions';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadMergedConfig } from './mergedConfig.mjs';
import draco3d from 'draco3dgltf';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const DIRECTORY = 'public/Assets/terrain/vegetation-lods';
const TEMP_DIRECTORY = 'public/tmp/lod-bake';
const config = await loadMergedConfig();
const mediumSettings = config.trees.lod.medium;
const lowSettings = config.trees.lod.low;

await mkdir(DIRECTORY, { recursive: true });
await mkdir(TEMP_DIRECTORY, { recursive: true });
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const count = doc => doc.getRoot().listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().reduce((n, p) =>
  n + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0), 0);

function select(doc, name) {
  const root = doc.getRoot().listNodes().find(node => node.getName() === name);
  if (!root) throw new Error(`Missing source ${name}`);
  for (const scene of doc.getRoot().listScenes()) scene.dispose();
  for (const parent of root.listParents()) if (parent.propertyType === 'Node') parent.removeChild(root);
  doc.createScene().addChild(root);
  const keep = new Set(); root.traverse(node => keep.add(node));
  for (const node of [...doc.getRoot().listNodes()]) if (!keep.has(node)) node.dispose();
  root.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
  root.setExtension('EXT_mesh_gpu_instancing', null);
  return root;
}

function findRoot(parent, index) {
  let root = index;
  while (parent[root] !== root) root = parent[root];
  while (parent[index] !== index) {
    const next = parent[index];
    parent[index] = root;
    index = next;
  }
  return root;
}

function union(parent, rank, a, b) {
  let rootA = findRoot(parent, a), rootB = findRoot(parent, b);
  if (rootA === rootB) return;
  if (rank[rootA] < rank[rootB]) [rootA, rootB] = [rootB, rootA];
  parent[rootB] = rootA;
  if (rank[rootA] === rank[rootB]) rank[rootA] += 1;
}

function componentHash(center) {
  let hash = 2166136261;
  for (const value of center) hash = Math.imul(hash ^ Math.round(value * 1000), 16777619);
  return hash >>> 0;
}

function bucketCoordinate(value, min, max, size) {
  const normalized = (value - min) / Math.max(max - min, 1e-6);
  return Math.min(size - 1, Math.max(0, Math.floor(normalized * size)));
}

function thinFoliageCards(document, primitive, settings) {
  if (primitive.getMode() !== Primitive.Mode.TRIANGLES) return false;
  const position = primitive.getAttribute('POSITION');
  if (!position || position.getCount() < 4) return false;
  const existingIndices = primitive.getIndices();
  const source = existingIndices?.getArray()
    ?? Uint32Array.from({ length: position.getCount() }, (_, index) => index);
  if (source.length < 6 || source.length % 3 !== 0) return false;

  const parent = new Int32Array(position.getCount()).fill(-1);
  const rank = new Uint8Array(position.getCount());
  const activate = index => { if (parent[index] < 0) parent[index] = index; };
  for (let i = 0; i < source.length; i += 3) {
    const a = source[i], b = source[i + 1], c = source[i + 2];
    activate(a); activate(b); activate(c);
    union(parent, rank, a, b); union(parent, rank, b, c);
  }

  const groups = new Map();
  const point = [0, 0, 0];
  for (let i = 0; i < source.length; i += 3) {
    const root = findRoot(parent, source[i]);
    let group = groups.get(root);
    if (!group) {
      group = { root, triangles: 0, sum: [0, 0, 0], samples: 0 };
      groups.set(root, group);
    }
    group.triangles += 1;
    for (let corner = 0; corner < 3; corner += 1) {
      position.getElement(source[i + corner], point);
      group.sum[0] += point[0]; group.sum[1] += point[1]; group.sum[2] += point[2];
      group.samples += 1;
    }
  }

  const components = [...groups.values()].map(group => ({
    ...group,
    center: group.sum.map(value => value / group.samples),
  }));
  const triangleCount = source.length / 3;
  if (components.length < settings.minComponents
    || Math.max(...components.map(component => component.triangles)) / triangleCount > settings.maxComponentShare) {
    return false;
  }

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const component of components) for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Math.min(min[axis], component.center[axis]);
    max[axis] = Math.max(max[axis], component.center[axis]);
  }

  const buckets = new Map();
  for (const component of components) {
    const cell = component.center.map((value, axis) =>
      bucketCoordinate(value, min[axis], max[axis], settings.grid[axis])).join(',');
    const bucket = buckets.get(cell) ?? [];
    bucket.push(component);
    buckets.set(cell, bucket);
  }

  const selectedRoots = new Set();
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => componentHash(a.center) - componentHash(b.center));
    const keep = Math.max(1, Math.round(bucket.length * settings.foliageKeepRatio));
    for (let i = 0; i < keep; i += 1) selectedRoots.add(bucket[i].root);
  }

  const selected = [];
  for (let i = 0; i < source.length; i += 3) {
    if (!selectedRoots.has(findRoot(parent, source[i]))) continue;
    selected.push(source[i], source[i + 1], source[i + 2]);
  }
  if (selected.length >= source.length || selected.length < 3) return false;

  const IndexArray = position.getCount() > 65535 ? Uint32Array : Uint16Array;
  const indices = document.createAccessor(
    `${primitive.getMaterial()?.getName() || 'Foliage'} Low indices`,
    existingIndices?.getBuffer() ?? position.getBuffer(),
  ).setType('SCALAR').setArray(new IndexArray(selected));
  primitive.setIndices(indices);
  compactPrimitive(primitive);
  return true;
}

function simplifyTree(document, { woodRatio, woodError, thinFoliage, foliage }) {
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const material = primitive.getMaterial();
    const materialName = material?.getName() ?? '';
    if (/snow/i.test(materialName)) continue;
    if (material?.getAlphaMode() !== 'OPAQUE') {
      if (thinFoliage) thinFoliageCards(document, primitive, foliage);
      continue;
    }
    simplifyPrimitive(primitive, { simplifier: MeshoptSimplifier, ratio: woodRatio, error: woodError });
  }
}

function usesCanopyPalette(document) {
  return !document.getRoot().listMaterials().some(material => /snow/i.test(material.getName() ?? ''));
}

function addBundle(name, document, bundles) {
  if (bundles.has(name)) mergeDocuments(bundles.get(name), document);
  else bundles.set(name, document);
}

// Atlas bakes read the untouched source, so existing captures survive a regeneration.
const previous = JSON.parse(
  await readFile(`${DIRECTORY}/manifest.json`, 'utf8').catch(() => '{"variants":{}}'),
).variants ?? {};

// Understory and far-grass atlases are generated by separate pipelines.
const preserved = Object.fromEntries(
  Object.entries(previous).filter(([, entry]) => entry.understory || entry.grass),
);
const manifest = { version: 2, variants: preserved };
const bundles = new Map();

async function generate(source, nodeName, key, tree) {
  const full = cloneDocument(source);
  const root = select(full, nodeName); root.setName(key);
  await full.transform(prune(), weld());
  await io.write(`${TEMP_DIRECTORY}/${key}.glb`, full);
  const counts = [count(full)];

  if (tree) {
    const medium = cloneDocument(full);
    medium.getRoot().listScenes()[0].listChildren()[0].setName(`${key}_Medium`);
    simplifyTree(medium, {
      woodRatio: mediumSettings.woodRatio,
      woodError: mediumSettings.woodError,
      thinFoliage: false,
      foliage: lowSettings,
    });
    await medium.transform(prune());
    counts.push(count(medium));

    const low = cloneDocument(medium);
    low.getRoot().listScenes()[0].listChildren()[0].setName(`${key}_Low`);
    simplifyTree(low, {
      woodRatio: lowSettings.woodRatio,
      woodError: lowSettings.woodError,
      thinFoliage: true,
      foliage: lowSettings,
    });
    await low.transform(prune());
    counts.push(count(low));

    const bundle = key.startsWith('jungle-') ? 'jungle' : 'forest';
    addBundle(bundle, medium, bundles);
    addBundle(bundle, low, bundles);
  }

  manifest.variants[key] = {
    ...(previous[key] ?? {}),
    tree,
    triangles: counts,
    mesh: tree ? `${key.startsWith('jungle-') ? 'jungle' : 'forest'}.glb` : null,
    medium: tree ? `${key}_Medium` : undefined,
    lowMesh: tree ? `${key}_Low` : undefined,
    canopyPalette: tree ? (!key.startsWith('jungle-') && usesCanopyPalette(full)) : undefined,
    atlas: previous[key]?.atlas ?? `${key}.webp`,
    alphaCutoff: previous[key]?.alphaCutoff ?? 0.35,
    capture: previous[key]?.capture,
  };
  console.log(`${key}: ${counts.join(' → ')} triangles`);
}

for (let type = 1; type <= 19; type += 1) {
  const source = await io.read(`public/Assets/terrain/fantasy/tree${type}.glb`);
  await generate(source, `Tree${type}_High`, `tree${type}`, true);
}

const jungle = await io.read('public/Assets/terrain/coastal-jungle/scenes/coastal_jungle_v2_reference.glb');
for (const node of jungle.getRoot().listNodes()) {
  if (!node.getMesh() || ['ForestFloor', 'ForestPath'].includes(node.getName())) continue;
  const name = node.getName();
  const key = name.replace(/_instances$/, '');
  await generate(jungle, name, `jungle-${key}`, /^(background_tree|tree|palm|ForegroundPalm)/.test(key));
}

for (const [name, bundle] of bundles) {
  const scenes = bundle.getRoot().listScenes();
  for (const scene of scenes.slice(1)) {
    for (const node of scene.listChildren()) scenes[0].addChild(node);
    scene.dispose();
  }
  await bundle.transform(
    dedup(),
    prune(),
    unpartition(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 82, effort: 100 }),
    draco({ quantizePosition: 16, quantizeTexcoord: 14 }),
  );
  await io.write(`${DIRECTORY}/${name}.glb`, bundle);
}

await writeFile(`${DIRECTORY}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
