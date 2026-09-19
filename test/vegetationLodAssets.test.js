import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco from 'draco3dgltf';
import sharp from 'sharp';

test('shipped tree derivatives reduce geometry and all variants have compact eight-view atlases', async () => {
  const base = 'public/Assets/terrain/vegetation-lods/';
  const manifest = JSON.parse(await readFile(base + 'manifest.json', 'utf8'));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco.createDecoderModule() });
  const forest = await io.read(base + 'forest.glb'), jungle = await io.read(base + 'jungle.glb');
  let bytes = 0;
  for (const [key, entry] of Object.entries(manifest.variants)) {
    const image = await sharp(base + entry.atlas).metadata();
    assert.equal(image.width, entry.capture.tileSize * 8, key); assert.equal(image.height, entry.capture.tileSize, key);
    assert.equal(image.hasAlpha, true, key); assert.equal(image.format, 'webp'); bytes += (await stat(base + entry.atlas)).size;
    if (!entry.tree) continue;
    assert.ok(entry.triangles[1] < entry.triangles[0], `${key} medium budget`);
    assert.ok(entry.triangles[2] < entry.triangles[1], `${key} low budget`);
    const doc = key.startsWith('jungle-') ? jungle : forest;
    for (const name of [entry.medium, entry.lowMesh]) {
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
      assert.ok(top - bottom >= sourceHeight * 0.8 && top - bottom <= sourceHeight * 1.02, `${name} silhouette height`);
    }
  }
  assert.ok(bytes < 2_000_000, `atlas transfer budget: ${bytes}`);
});
