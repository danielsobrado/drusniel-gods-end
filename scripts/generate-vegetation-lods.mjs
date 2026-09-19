/** Offline derivatives of the shipped forest/alpine/jungle assets; originals remain untouched. */
import { mkdir, writeFile } from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { cloneDocument, mergeDocuments, prune, weld, simplifyPrimitive, draco, unpartition, dedup, textureCompress } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const directory = 'public/Assets/terrain/vegetation-lods';
await mkdir(directory, { recursive: true });
await mkdir('public/tmp/lod-bake', { recursive: true });
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(), 'draco3d.encoder': await draco3d.createEncoderModule(),
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

// Retain whole connected leaf cards, stratified across the crown. Never slice a card into random triangles.
function thinCards(doc, ratio) {
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    if (p.getMaterial()?.getAlphaMode() !== 'MASK') continue;
    const pos = p.getAttribute('POSITION'), indices = p.getIndices()?.getArray();
    if (!indices) continue;
    const parent = Int32Array.from({ length: pos.getCount() }, (_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < indices.length; i += 3) {
      parent[find(indices[i + 1])] = find(indices[i]); parent[find(indices[i + 2])] = find(indices[i]);
    }
    const components = new Map();
    for (let i = 0; i < indices.length; i += 3) {
      const key = find(indices[i]);
      if (!components.has(key)) components.set(key, []);
      components.get(key).push(indices[i], indices[i + 1], indices[i + 2]);
    }
    if (components.size < 16) continue;
    const min = pos.getMin([]), max = pos.getMax([]), cells = new Map();
    for (const [key, tris] of components) {
      const vertices = [...new Set(tris)], center = [0, 0, 0];
      for (const index of vertices) { const v = pos.getElement(index, []); for (let a = 0; a < 3; a++) center[a] += v[a] / vertices.length; }
      const cell = center.map((v, a) => Math.min(4, Math.floor((v - min[a]) / Math.max(1e-5, max[a] - min[a]) * 5))).join(',');
      if (!cells.has(cell)) cells.set(cell, []);
      cells.get(cell).push({ key, tris });
    }
    const kept = [];
    for (const entries of cells.values()) {
      entries.sort((a, b) => ((Math.imul(a.key + 1, 2654435761) >>> 0) - (Math.imul(b.key + 1, 2654435761) >>> 0)));
      for (const entry of entries.slice(0, Math.max(1, Math.ceil(entries.length * ratio)))) kept.push(...entry.tris);
    }
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(kept)).setBuffer(doc.getRoot().listBuffers()[0]));
  }
}

const manifest = { version: 1, variants: {} };
const bundles = new Map();
async function generate(source, nodeName, key, tree) {
  const full = cloneDocument(source);
  const root = select(full, nodeName); root.setName(key);
  await full.transform(prune(), weld());
  await io.write(`public/tmp/lod-bake/${key}.glb`, full);
  const counts = [count(full)];
  if (tree) {
    let output;
    for (const [index, ratio] of [0.5, 0.2].entries()) {
      const lod = cloneDocument(full);
      lod.getRoot().listScenes()[0].listChildren()[0].setName(`${key}_${index === 0 ? 'Medium' : 'LowMesh'}`);
      thinCards(lod, ratio);
      for (const mesh of lod.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
        // Snow caps have coincident seam vertices. Keep their closed source topology;
        // simplifying disconnected seams independently opens visible cracks.
        if (primitive.getMaterial()?.getAlphaMode() !== 'MASK' && !/snow/i.test(primitive.getMaterial()?.getName() ?? '')) simplifyPrimitive(primitive,
          { simplifier: MeshoptSimplifier, ratio, error: index === 0 ? 0.003 : 0.01 });
      }
      await lod.transform(prune());
      counts.push(count(lod));
      if (!output) output = lod; else mergeDocuments(output, lod);
    }
    // GLTFLoader reads one scene. Move both levels under it before serialization.
    const scenes = output.getRoot().listScenes();
    for (const scene of scenes.slice(1)) { for (const node of scene.listChildren()) scenes[0].addChild(node); scene.dispose(); }
    const bundle = key.startsWith('jungle-') ? 'jungle' : 'forest';
    if (bundles.has(bundle)) mergeDocuments(bundles.get(bundle), output); else bundles.set(bundle, output);
  }
  manifest.variants[key] = { tree, triangles: counts, mesh: tree ? `${key.startsWith('jungle-') ? 'jungle' : 'forest'}.glb` : null,
    medium: `${key}_Medium`, lowMesh: `${key}_LowMesh`, atlas: `${key}.webp` };
  console.log(`${key}: ${counts.join(' → ')} triangles`);
}
for (let type = 1; type <= 19; type++) {
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
  for (const scene of scenes.slice(1)) { for (const node of scene.listChildren()) scenes[0].addChild(node); scene.dispose(); }
  await bundle.transform(dedup(), prune(), unpartition(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 82, effort: 100 }),
    draco({ quantizePosition: 16, quantizeTexcoord: 14 }));
  await io.write(`${directory}/${name}.glb`, bundle);
}
await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
