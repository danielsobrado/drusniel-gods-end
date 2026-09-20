import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { cloneDocument, prune } from '@gltf-transform/functions';
import yaml from 'js-yaml';

const SOURCE = 'public/Assets/terrain/understories/low_poly_stylized_plants_pack_free.glb';
const OUTPUT = 'public/tmp/lod-bake';
const MANIFEST = 'public/Assets/terrain/vegetation-lods/manifest.json';
const PREFIX = 'understory-';
const PLANT_PATTERN = /^Plants_\d+$/i;

function triangles(document) {
  return document.getRoot().listMeshes().reduce((sum, mesh) => sum
    + mesh.listPrimitives().reduce((count, primitive) => count
      + (primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION').getCount()) / 3, 0), 0);
}

function isolate(document, name, worldScale) {
  const root = document.getRoot().listNodes().find((node) => node.getName() === name);
  if (!root) throw new Error(`Missing understory root ${name}`);

  const translation = root.getWorldTranslation();
  const rotation = root.getWorldRotation();
  const scale = root.getWorldScale().map((value) => value * worldScale);

  for (const scene of document.getRoot().listScenes()) scene.dispose();
  for (const parent of root.listParents()) {
    if (parent.propertyType === 'Node') parent.removeChild(root);
  }
  document.createScene().addChild(root);
  root.setTranslation(translation).setRotation(rotation).setScale(scale);

  const keep = new Set();
  root.traverse((node) => keep.add(node));
  for (const node of [...document.getRoot().listNodes()]) {
    if (!keep.has(node)) node.dispose();
  }
  return root;
}

await mkdir(OUTPUT, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const source = await io.read(SOURCE);
const foliage = yaml.load(await readFile('public/foliage.yaml', 'utf8'));
const worldScale = Number(foliage?.foliage?.understory?.worldScale ?? 1);
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const names = source.getRoot().listNodes()
  .map((node) => node.getName())
  .filter((name) => PLANT_PATTERN.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

if (names.length === 0) throw new Error('No understory Plants_* roots found.');

for (const name of names) {
  const key = PREFIX + name;
  const document = cloneDocument(source);
  isolate(document, name, worldScale);
  await document.transform(prune());
  await io.write(`${OUTPUT}/${key}.glb`, document);

  const previous = manifest.variants[key] ?? {};
  manifest.variants[key] = {
    tree: false,
    understory: true,
    triangles: [triangles(document)],
    mesh: null,
    atlas: previous.atlas ?? `${key}.webp`,
    capture: previous.capture,
  };
  console.log(`Prepared ${key}`);
}

await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
