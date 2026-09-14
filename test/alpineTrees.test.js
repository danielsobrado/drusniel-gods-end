import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco from 'draco3dgltf';
import { createAlpineTrees } from '../src/world/AlpineTrees.js';
import { resolveAlpineConfig, shapeAlpineHeight } from '../src/world/AlpineRegion.js';

test('snow tree placement is stable, varied and excludes paths and steep peaks', async () => {
  const alpine = resolveAlpineConfig(yaml.load(await readFile('public/alpine.yaml', 'utf8')));
  const terrain = { sampleHeight: (x, z) => shapeAlpineHeight(x, z, 80, alpine) };
  const paths = { sample: x => Math.abs(x - alpine.centerX) < 6 ? 1 : 0 };
  const records = createAlpineTrees(alpine, terrain, paths);
  assert.ok(records.length > 5 && records.length < 100);
  assert.deepEqual(records, createAlpineTrees(alpine, terrain, paths));
  assert.equal(new Set(records.map(p => p[5])).size, 2);
  assert.ok(new Set(records.map(p => p[4])).size > 5);
  for (const [x, y, z] of records) {
    assert.ok(y >= alpine.treeLine && y <= alpine.basinHeight + 28);
    assert.equal(y, terrain.sampleHeight(x, z));
    assert.ok(Math.abs(x - alpine.centerX) >= 10);
  }
  assert.deepEqual(createAlpineTrees(null, terrain, paths), []);
});

test('both alpine GLBs have rooted trunks, snow, three shared materials and baked LODs', async () => {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco.createDecoderModule() });
  for (const type of [10, 11]) {
    const doc = await io.read(`public/Assets/terrain/fantasy/tree${type}.glb`);
    const high = doc.getRoot().listNodes().find(n => n.getName() === `Tree${type}_High`);
    const low = doc.getRoot().listNodes().find(n => n.getName() === `Tree${type}_Low`);
    assert.equal(high.getExtras().roots, 6);
    assert.equal(high.listChildren().length, 3);
    const bark = high.listChildren()[0].getMesh().listPrimitives()[0];
    assert.ok(bark.getAttribute('POSITION').getMin([])[1] < 0);
    assert.ok(bark.getMaterial().getBaseColorTexture());
    assert.ok(high.listChildren().every(n => n.getMesh().listPrimitives()[0].getMaterial().getMetallicFactor() === 0));
    const baked = await readFile(`public/Assets/terrain/fantasy-textures/billboard-${type}.png`);
    low.traverse(n => { for (const p of n.getMesh()?.listPrimitives() ?? []) {
      assert.deepEqual(Buffer.from(p.getMaterial().getBaseColorTexture().getImage()), baked);
      assert.equal(p.getMaterial().getExtras().snowPalette, true);
    } });
  }
});
