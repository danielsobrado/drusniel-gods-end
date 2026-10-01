import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco from 'draco3dgltf';
import sharp from 'sharp';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

const REQUIRE_TREE_LOW_LODS = process.env.REQUIRE_TREE_LOW_LODS === '1';
const REQUIRE_TREE_IMPOSTOR_MAPS = process.env.REQUIRE_TREE_IMPOSTOR_MAPS === '1';
const REQUIRE_TREE_IMPOSTOR_CAPTURE = process.env.REQUIRE_TREE_IMPOSTOR_CAPTURE === '1';

function maskedTriangles(doc, name) {
  let total = 0;
  doc.getRoot().listNodes().find(n => n.getName() === name).traverse(node => {
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      if (primitive.getMaterial()?.getAlphaMode() !== 'MASK') continue;
      total += (primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION').getCount()) / 3;
    }
  });
  return total;
}

test('shipped tree derivatives reduce geometry and all variants have compact multi-view atlases', async () => {
  const base = 'public/Assets/terrain/vegetation-lods/';
  const config = await loadMergedConfig();
  const manifest = JSON.parse(await readFile(base + 'manifest.json', 'utf8'));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco.createDecoderModule() });
  const forest = await io.read(base + 'forest.glb'), jungle = await io.read(base + 'jungle.glb');
  const keys = Object.keys(manifest.variants);
  assert.deepEqual(
    ['grass-slender', 'grass-reed', 'grass-broadleaf'].filter((key) => !keys.includes(key)),
    [],
    'far grass manifest entries must survive regeneration',
  );
  const understoryKeys = keys.filter((key) => key.startsWith('understory-'));
  if (process.env.REQUIRE_UNDERSTORY_ATLASES === '1') {
    assert.ok(understoryKeys.length > 0, 'understory manifest entries must be generated');
  }
  let primaryBytes = 0;
  for (const [key, entry] of Object.entries(manifest.variants)) {
    const image = await sharp(base + entry.atlas).metadata();
    assert.equal(image.hasAlpha, true, key);
    assert.equal(image.format, 'webp', key);
    const atlasBytes = (await stat(base + entry.atlas)).size;
    if (!entry.understory) primaryBytes += atlasBytes;

    if (entry.grass) {
      assert.equal(entry.alphaCutoff, 0.5, `${key} grass cutoff`);
      assert.equal(entry.capture, undefined, `${key} must be atlas-only`);
      continue;
    }

    assert.ok(entry.capture, `${key} capture metadata`);
    assert.equal(image.width, entry.capture.tileSize * entry.capture.views, key);
    assert.equal(image.height, entry.capture.tileSize, key);
    if (entry.tree && REQUIRE_TREE_IMPOSTOR_CAPTURE) {
      assert.equal(entry.capture.views, config.trees.lod.impostor.views, `${key} tree view count`);
      assert.equal(entry.capture.tileSize, config.trees.lod.impostor.tileSize, `${key} tree tile size`);
      assert.equal(entry.capture.gutter, config.trees.lod.impostor.gutter, `${key} tree gutter`);
    }
    if (key.startsWith('understory-')) {
      assert.equal(entry.alphaCutoff, 0.1, `${key} understory cutoff`);
    }
    if (!entry.tree) continue;
    if (REQUIRE_TREE_IMPOSTOR_CAPTURE && key.startsWith('jungle-')) {
      assert.equal(entry.canopyPalette, false, `${key} must retain coastal-jungle color treatment`);
    }
    if (REQUIRE_TREE_IMPOSTOR_MAPS) assert.ok(entry.normalMask, `${key} normal/mask atlas is required`);
    if (entry.normalMask) {
      const normalMask = await sharp(base + entry.normalMask).metadata();
      assert.equal(normalMask.format, 'webp', `${key} normal/mask format`);
      assert.equal(normalMask.hasAlpha, true, `${key} normal/mask alpha`);
      assert.equal(normalMask.width, image.width, `${key} normal/mask width`);
      assert.equal(normalMask.height, image.height, `${key} normal/mask height`);
    }
    assert.ok(entry.triangles[1] < entry.triangles[0], `${key} medium budget`);
    if (REQUIRE_TREE_LOW_LODS) assert.ok(entry.lowMesh, `${key} low mesh is required`);
    if (entry.lowMesh) {
      assert.equal(entry.triangles.length, 3, `${key} has two mesh derivatives`);
      assert.ok(entry.triangles[2] <= entry.triangles[1], `${key} low budget`);
    } else {
      assert.equal(entry.triangles.length, 2, `${key} legacy derivative count`);
    }
    const doc = key.startsWith('jungle-') ? jungle : forest;
    if (/^tree\d+$/.test(key)) {
      // Leaf cards read as a canopy only through overlap; thinning them exposes the planes.
      const type = key.slice(4);
      const source = await io.read(`public/Assets/terrain/fantasy/tree${type}.glb`);
      const root = source.getRoot().listNodes().find(n => n.getName() === `Tree${type}_High`);
      assert.equal(maskedTriangles(doc, entry.medium), maskedTriangles(source, root.getName()),
        `${key} medium must keep every leaf card`);
      if (entry.lowMesh) {
        assert.ok(maskedTriangles(doc, entry.lowMesh) <= maskedTriangles(doc, entry.medium),
          `${key} low foliage budget`);
      }
    }
    for (const name of [entry.medium, entry.lowMesh].filter(Boolean)) {
      const root = doc.getRoot().listNodes().find(n => n.getName() === name); assert.ok(root, name);
      let bottom = Infinity, top = -Infinity;
      root.traverse(node => {
        for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
          const positions = primitive.getAttribute('POSITION');
          const matrix = node.getWorldMatrix(), point = [];
          for (let i = 0; i < positions.getCount(); i++) {
            positions.getElement(i, point);
            const y = matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13];
            bottom = Math.min(bottom, y); top = Math.max(top, y);
          }
          assert.ok(positions.getArray().every(Number.isFinite), `${name} finite positions`);
          if (!/snow/i.test(primitive.getMaterial()?.getName() ?? '')) continue;
          const keys = Array.from({ length: positions.getCount() }, (_, i) => positions.getElement(i, []).map(v => v.toFixed(5)).join(','));
          const indices = primitive.getIndices().getArray(), edges = new Map();
          for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3; j++) {
            const edge = [keys[indices[i + j]], keys[indices[i + (j + 1) % 3]]].sort().join('|');
            edges.set(edge, (edges.get(edge) ?? 0) + 1);
          }
          assert.ok([...edges.values()].every(n => n === 2), `${name} closed snow surfaces`);
        }
      });
      const sourceHeight = entry.capture.height / 1.06;
      const minimumHeight = name === entry.medium ? 0.8 : 0.7;
      assert.ok(top - bottom >= sourceHeight * minimumHeight && top - bottom <= sourceHeight * 1.02,
        `${name} silhouette height`);
    }
  }
  assert.ok(primaryBytes < 2_000_000, `primary atlas transfer budget: ${primaryBytes}`);
});
