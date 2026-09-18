import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco from 'draco3dgltf';
import { ALPINE_TREE_TYPES, createAlpineTrees } from '../src/world/AlpineTrees.js';
import { resolveAlpineConfig, shapeAlpineHeight } from '../src/world/AlpineRegion.js';

test('snow trees grow in groves clear of routes and teleports, and mix four species', async () => {
  const alpine = resolveAlpineConfig(yaml.load(await readFile('public/alpine.yaml', 'utf8')));
  const terrain = { sampleHeight: (x, z) => shapeAlpineHeight(x, z, 80, alpine) };
  const paths = { sample: x => Math.abs(x - alpine.centerX) < 6 ? 1 : 0 };
  const clearing = [alpine.centerX + 60, alpine.centerZ];
  const options = { clearings: [clearing], windAngleDegrees: 150 };
  const records = createAlpineTrees(alpine, terrain, paths, options);
  assert.ok(records.length > 20 && records.length < 250);
  assert.deepEqual(records, createAlpineTrees(alpine, terrain, paths, options));
  assert.deepEqual(new Set(records.map(p => p[5])), new Set(Object.values(ALPINE_TREE_TYPES)));
  assert.ok(new Set(records.map(p => p[4].toFixed(2))).size > 10);
  for (const [x, y, z, rotation, , type] of records) {
    assert.ok(y >= alpine.treeLine && y <= alpine.basinHeight + 28);
    assert.equal(y, terrain.sampleHeight(x, z));
    assert.ok(Math.abs(x - alpine.centerX) >= 10);
    assert.ok(Math.hypot(x - clearing[0], z - clearing[1]) >= 16);
    // Wind-flagged species all turn their long boughs downwind.
    if (type === ALPINE_TREE_TYPES.pine || type === ALPINE_TREE_TYPES.fir) {
      assert.ok(Math.abs(rotation + 150 * Math.PI / 180) <= 0.3 + 1e-9);
    }
  }
  // Trunks never touch, but most trees stand in a grove with close neighbours.
  const neighbours = records.map(([x, , z], i) => records.filter(([ox, , oz], j) => j !== i && Math.hypot(ox - x, oz - z) < 13).length);
  for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) {
    assert.ok(Math.hypot(records[i][0] - records[j][0], records[i][2] - records[j][2]) > 3);
  }
  assert.ok(neighbours.filter(count => count >= 2).length > records.length * 0.5);
  assert.deepEqual(createAlpineTrees(null, terrain, paths), []);
});

test('reshaping one part of the region leaves trees elsewhere where they were', async () => {
  const alpine = resolveAlpineConfig(yaml.load(await readFile('public/alpine.yaml', 'utf8')));
  const base = (x, z) => shapeAlpineHeight(x, z, 80, alpine);
  const paths = { sample: () => 0 };
  const cut = alpine.centerZ - 120;
  const north = records => records.filter(p => p[2] > cut + 20);
  const whole = createAlpineTrees(alpine, { sampleHeight: base }, paths);
  const trimmed = createAlpineTrees(alpine, { sampleHeight: (x, z) => z < cut ? Number.NaN : base(x, z) }, paths);
  assert.ok(north(whole).length > 10);
  assert.deepEqual(north(trimmed), north(whole));
});

test('all four alpine GLBs have rooted trunks, vertex-shaded needles and snow, three materials and baked LODs', async () => {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco.createDecoderModule() });
  for (const type of [10, 11, 12, 13]) {
    const doc = await io.read(`public/Assets/terrain/fantasy/tree${type}.glb`);
    const high = doc.getRoot().listNodes().find(n => n.getName() === `Tree${type}_High`);
    const low = doc.getRoot().listNodes().find(n => n.getName() === `Tree${type}_Low`);
    assert.equal(high.getExtras().roots, 6);
    assert.equal(high.listChildren().length, 3);
    const bark = high.listChildren()[0].getMesh().listPrimitives()[0];
    assert.ok(bark.getAttribute('POSITION').getMin([])[1] < 0);
    assert.ok(bark.getMaterial().getBaseColorTexture());
    assert.ok(high.listChildren().every(n => n.getMesh().listPrimitives()[0].getMaterial().getMetallicFactor() === 0));
    for (const child of high.listChildren().slice(1)) {
      const primitive = child.getMesh().listPrimitives()[0];
      assert.ok(primitive.getAttribute('COLOR_0'));
      assert.equal(primitive.getMaterial().getDoubleSided(), true);
    }
    const baked = await readFile(`public/Assets/terrain/fantasy-textures/billboard-${type}.png`);
    low.traverse(n => { for (const p of n.getMesh()?.listPrimitives() ?? []) {
      assert.deepEqual(Buffer.from(p.getMaterial().getBaseColorTexture().getImage()), baked);
      assert.equal(p.getMaterial().getExtras().snowPalette, true);
    } });
  }
});
