/** Offline derivatives of the shipped forest/alpine/jungle assets; originals remain untouched. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

// Atlas bakes read the untouched source, so existing captures survive a regeneration.
const previous = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8').catch(() => '{"variants":{}}')).variants;

const manifest = { version: 2, variants: {} };
const bundles = new Map();
async function generate(source, nodeName, key, tree) {
  const full = cloneDocument(source);
  const root = select(full, nodeName); root.setName(key);
  await full.transform(prune(), weld());
  await io.write(`public/tmp/lod-bake/${key}.glb`, full);
  const counts = [count(full)];
  if (tree) {
    // Leaf cards are authored to read as a canopy through heavy overlap, so every card
    // survives here; dropping a fraction of them exposes the individual planes. Only the
    // woody geometry simplifies, and the whole-tree impostor takes over past Medium.
    const lod = cloneDocument(full);
    lod.getRoot().listScenes()[0].listChildren()[0].setName(`${key}_Medium`);
    for (const mesh of lod.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      // Snow caps have coincident seam vertices. Keep their closed source topology;
      // simplifying disconnected seams independently opens visible cracks.
      if (primitive.getMaterial()?.getAlphaMode() !== 'MASK' && !/snow/i.test(primitive.getMaterial()?.getName() ?? '')) simplifyPrimitive(primitive,
        { simplifier: MeshoptSimplifier, ratio: 0.5, error: 0.003 });
    }
    await lod.transform(prune());
    counts.push(count(lod));
    const bundle = key.startsWith('jungle-') ? 'jungle' : 'forest';
    if (bundles.has(bundle)) mergeDocuments(bundles.get(bundle), lod); else bundles.set(bundle, lod);
  }
  manifest.variants[key] = { tree, triangles: counts, mesh: tree ? `${key.startsWith('jungle-') ? 'jungle' : 'forest'}.glb` : null,
    medium: `${key}_Medium`, atlas: previous[key]?.atlas ?? `${key}.webp`, capture: previous[key]?.capture };
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
