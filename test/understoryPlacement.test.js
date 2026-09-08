import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseGlb } from '../scripts/glb.mjs';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';
import {
  DEFAULT_UNDERSTORY,
  placeUnderstoryPlants,
  resolveUnderstorySettings,
  understoryPlacementChance,
} from '../src/foliage/understoryPlacement.js';

const PACK = fileURLToPath(
  new URL('../public/Assets/terrain/understories/low_poly_stylized_plants_pack_free.glb', import.meta.url),
);

const shade = { density: 0.55, growth: 0.5, moisture: 0.6, path: 0, understory: 0.72 };

function fixtureConfig(overrides = {}) {
  return {
    foliage: {
      understory: {
        ...DEFAULT_UNDERSTORY,
        quality: {
          performance: { density: 0.3, radius: 0.46, shadows: false },
          balanced: { density: 0.52, radius: 0.68, shadows: false },
          high: { density: 0.84, radius: 0.9, shadows: true },
          ultra: { density: 1, radius: 1, shadows: true },
        },
      },
    },
    presets: {
      rainy: { foliage: { understory: { enabled: true, density: 0.86 } } },
      moonlight: { foliage: { understory: { enabled: true, density: 0.22 } } },
      barren: { foliage: { understory: { enabled: false } } },
    },
    ...overrides,
  };
}

function place(settings, extras = {}) {
  return placeUnderstoryPlants({
    origin: { x: 0, z: 0 },
    settings,
    variantCount: 10,
    sampleEcology: () => shade,
    contains: () => true,
    sampleHeight: () => 1.2,
    waterY: 0,
    ...extras,
  });
}

test('the understory pack has ten plant variants and a MASK atlas', () => {
  const { json } = parseGlb(readFileSync(PACK));
  const root = json.nodes.find((node) => node.name === 'RootNode');
  const plants = (root?.children ?? [])
    .map((index) => json.nodes[index])
    .filter((node) => /^Plants_\d+$/i.test(node.name));
  assert.equal(plants.length, 10);
  assert.equal(json.meshes.length, 10);
  assert.equal(json.materials.length, 1);
  assert.equal(json.materials[0].alphaMode, 'MASK');
  assert.equal(json.materials[0].alphaCutoff, 0.1);
  assert.equal(json.materials[0].doubleSided, true);
  assert.ok(json.materials[0].pbrMetallicRoughness?.baseColorTexture);
});

test('disabled preset produces no understory instances', () => {
  const settings = resolveUnderstorySettings(fixtureConfig(), 'barren', 'ultra');
  assert.equal(settings.enabled, false);
  assert.equal(place(settings).length, 0);
});

test('same seed and cell produce deterministic understory placement', () => {
  const settings = resolveUnderstorySettings(fixtureConfig(), 'rainy', 'high');
  const first = place(settings);
  const second = place(settings);
  assert.ok(first.length > 0);
  assert.deepEqual(first, second);
});

test('paths reject understory placement', () => {
  const settings = resolveUnderstorySettings(fixtureConfig(), 'rainy', 'high');
  assert.equal(understoryPlacementChance({ ...shade, path: 0.9 }, settings), 0);
  assert.equal(place(settings, { sampleEcology: () => ({ ...shade, path: 1 }) }).length, 0);
});

test('insufficient understory ecology rejects placement', () => {
  const settings = resolveUnderstorySettings(fixtureConfig(), 'rainy', 'high');
  assert.equal(understoryPlacementChance({ ...shade, understory: 0.05, density: 0.9 }, settings), 0);
  assert.equal(place(settings, {
    sampleEcology: () => ({ ...shade, understory: 0.05, density: 0.9 }),
  }).length, 0);
});

test('preset switching changes understory density and enabled state', () => {
  const config = fixtureConfig();
  const rainy = resolveUnderstorySettings(config, 'rainy', 'high');
  const moonlight = resolveUnderstorySettings(config, 'moonlight', 'high');
  const barren = resolveUnderstorySettings(config, 'barren', 'high');
  assert.equal(rainy.enabled, true);
  assert.equal(moonlight.enabled, true);
  assert.ok(rainy.density > moonlight.density);
  assert.equal(barren.enabled, false);
  assert.ok(place(rainy).length > place(moonlight).length);
});

test('quality changes affect understory population count and radius', () => {
  const config = fixtureConfig();
  const performance = resolveUnderstorySettings(config, 'rainy', 'performance');
  const ultra = resolveUnderstorySettings(config, 'rainy', 'ultra');
  assert.ok(performance.radius < ultra.radius);
  assert.ok(performance.candidatesPerCell < ultra.candidatesPerCell);
  assert.equal(performance.castShadow, false);
  assert.equal(ultra.castShadow, true);
  assert.ok(place(ultra).length > place(performance).length);
});

test('invalid or missing understory configuration is handled safely', () => {
  assert.doesNotThrow(() => resolveUnderstorySettings(undefined, 'missing', 'nope'));
  const fallback = resolveUnderstorySettings({}, 'missing', 'nope');
  assert.equal(fallback.enabled, DEFAULT_UNDERSTORY.enabled);
  assert.ok(fallback.radius > 0);
  assert.deepEqual(placeUnderstoryPlants({}), []);
  assert.deepEqual(placeUnderstoryPlants({
    origin: { x: 0, z: 0 },
    settings: null,
    variantCount: 2,
  }), []);
});

test('merged foliage config enables understory on the intended presets', async () => {
  const config = await loadMergedConfig();
  assert.equal(
    config.assets.foliage.understory,
    'Assets/terrain/understories/low_poly_stylized_plants_pack_free.glb',
  );
  for (const name of ['sunny', 'goldenHour', 'rainy', 'windy', 'calm', 'bowed', 'moonlight']) {
    const settings = resolveUnderstorySettings(config, name, 'high');
    assert.equal(settings.enabled, true, `${name} should enable imported understory`);
  }
  const rainy = resolveUnderstorySettings(config, 'rainy', 'ultra');
  const moonlight = resolveUnderstorySettings(config, 'moonlight', 'ultra');
  const sunny = resolveUnderstorySettings(config, 'sunny', 'ultra');
  const windy = resolveUnderstorySettings(config, 'windy', 'ultra');
  assert.ok(rainy.density > moonlight.density);
  assert.ok(rainy.moistureBias > sunny.moistureBias);
  assert.ok(windy.windBend > sunny.windBend);
  assert.ok(rainy.minUnderstory > 0);
});
