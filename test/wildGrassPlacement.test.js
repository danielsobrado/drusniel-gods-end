import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseGlb } from '../scripts/glb.mjs';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';
import {
  DEFAULT_WILD_GRASS,
  placeWildGrassClumps,
  resolveWildGrassSettings,
  wildGrassPlacementChance,
} from '../src/foliage/wildGrassPlacement.js';

const PACK = path.resolve(
  fileURLToPath(new URL('../public/Assets/terrain/foliage/game_ready_grass.glb', import.meta.url)),
);

const healthy = { density: 0.9, growth: 0.8, moisture: 0.55, path: 0, understory: 0.1 };

function fixtureConfig(overrides = {}) {
  return {
    foliage: {
      wildGrass: {
        ...DEFAULT_WILD_GRASS,
        quality: {
          performance: { density: 0.32, radius: 0.48, shadows: false },
          balanced: { density: 0.55, radius: 0.7, shadows: false },
          high: { density: 0.85, radius: 0.9, shadows: true },
          ultra: { density: 1, radius: 1, shadows: true },
        },
      },
    },
    presets: {
      sunny: { foliage: { wildGrass: { enabled: true, density: 0.88 } } },
      moonlight: { foliage: { wildGrass: { enabled: true, density: 0.24 } } },
      barren: { foliage: { wildGrass: { enabled: false } } },
    },
    ...overrides,
  };
}

function place(settings, extras = {}) {
  return placeWildGrassClumps({
    origin: { x: 0, z: 0 },
    settings,
    variantCount: 4,
    sampleEcology: () => healthy,
    contains: () => true,
    sampleHeight: () => 1.2,
    waterY: 0,
    ...extras,
  });
}

test('the imported grass pack has four composed clumps and cutout card materials', () => {
  const { json } = parseGlb(readFileSync(PACK));
  const root = json.nodes.find((node) => node.name === 'RootNode');
  const clumpNodes = (root?.children ?? [])
    .map((index) => json.nodes[index])
    .filter((node) => (node.children?.length ?? 0) >= 2);
  assert.equal(clumpNodes.length, 4);
  assert.equal(json.meshes.length, 18);
  assert.equal(json.materials.length, 4);
  for (const material of json.materials) {
    assert.equal(material.alphaMode, 'BLEND');
    assert.equal(material.doubleSided, true);
    assert.ok(material.pbrMetallicRoughness?.baseColorTexture);
    assert.equal(material.pbrMetallicRoughness.metallicFactor, 0);
    assert.equal(material.normalTexture, undefined);
  }
});

test('disabled preset produces no instances', () => {
  const settings = resolveWildGrassSettings(fixtureConfig(), 'barren', 'ultra');
  assert.equal(settings.enabled, false);
  assert.equal(place(settings).length, 0);
});

test('same seed and cell produce deterministic placement', () => {
  const settings = resolveWildGrassSettings(fixtureConfig(), 'sunny', 'high');
  const first = place(settings);
  const second = place(settings);
  assert.ok(first.length > 0);
  assert.deepEqual(first, second);
});

test('paths reject wild-grass placement', () => {
  const settings = resolveWildGrassSettings(fixtureConfig(), 'sunny', 'high');
  assert.equal(wildGrassPlacementChance({ ...healthy, path: 0.9 }, settings), 0);
  assert.equal(place(settings, { sampleEcology: () => ({ ...healthy, path: 1 }) }).length, 0);
});

test('insufficient vegetation density rejects placement', () => {
  const settings = resolveWildGrassSettings(fixtureConfig(), 'sunny', 'high');
  assert.equal(wildGrassPlacementChance({ ...healthy, density: 0.05 }, settings), 0);
  assert.equal(wildGrassPlacementChance({ ...healthy, growth: 0.1 }, settings), 0);
  assert.equal(place(settings, { sampleEcology: () => ({ ...healthy, density: 0.05 }) }).length, 0);
});

test('typical meadow ecology still places a visible wild-grass layer', () => {
  const settings = resolveWildGrassSettings(fixtureConfig(), 'sunny', 'ultra');
  const meadow = { density: 0.4, growth: 0.64, moisture: 0.17, path: 0, understory: 0.1 };
  assert.ok(wildGrassPlacementChance(meadow, settings) > 0.25);
  assert.ok(place(settings, { sampleEcology: () => meadow }).length > 80);
});

test('preset switching changes density and enabled state', () => {
  const config = fixtureConfig();
  const sunny = resolveWildGrassSettings(config, 'sunny', 'high');
  const moonlight = resolveWildGrassSettings(config, 'moonlight', 'high');
  const barren = resolveWildGrassSettings(config, 'barren', 'high');
  assert.equal(sunny.enabled, true);
  assert.equal(moonlight.enabled, true);
  assert.ok(sunny.density > moonlight.density);
  assert.equal(barren.enabled, false);
  assert.ok(place(sunny).length > place(moonlight).length);
});

test('quality changes affect population count and radius', () => {
  const config = fixtureConfig();
  const performance = resolveWildGrassSettings(config, 'sunny', 'performance');
  const ultra = resolveWildGrassSettings(config, 'sunny', 'ultra');
  assert.ok(performance.radius < ultra.radius);
  assert.ok(performance.candidatesPerCell < ultra.candidatesPerCell);
  assert.equal(performance.castShadow, false);
  assert.equal(ultra.castShadow, true);
  assert.ok(place(ultra).length > place(performance).length);
});

test('invalid or missing configuration is handled safely', () => {
  assert.doesNotThrow(() => resolveWildGrassSettings(undefined, 'missing', 'nope'));
  const fallback = resolveWildGrassSettings({}, 'missing', 'nope');
  assert.equal(fallback.enabled, DEFAULT_WILD_GRASS.enabled);
  assert.ok(fallback.radius > 0);
  assert.deepEqual(placeWildGrassClumps({}), []);
  assert.deepEqual(placeWildGrassClumps({
    origin: { x: 0, z: 0 },
    settings: null,
    variantCount: 2,
  }), []);
});

test('merged foliage config enables wild grass on the intended presets', async () => {
  const config = await loadMergedConfig();
  assert.equal(config.assets.foliage.wildGrass, 'Assets/terrain/foliage/game_ready_grass.glb');
  for (const name of ['sunny', 'goldenHour', 'rainy', 'windy', 'calm', 'bowed', 'moonlight']) {
    const settings = resolveWildGrassSettings(config, name, 'high');
    assert.equal(settings.enabled, true, `${name} should enable imported wild grass`);
  }
  const sunny = resolveWildGrassSettings(config, 'sunny', 'ultra');
  const moonlight = resolveWildGrassSettings(config, 'moonlight', 'ultra');
  const rainy = resolveWildGrassSettings(config, 'rainy', 'ultra');
  const windy = resolveWildGrassSettings(config, 'windy', 'ultra');
  assert.ok(sunny.density > moonlight.density);
  assert.ok(rainy.moistureBias > sunny.moistureBias);
  assert.ok(windy.windBend > sunny.windBend);
});
