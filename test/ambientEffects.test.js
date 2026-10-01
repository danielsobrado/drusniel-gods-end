import test from 'node:test';
import assert from 'node:assert/strict';
import {
  presetWeight,
  resolveAmbientEffectsConfig,
  resolveJungleMistConfig,
  windFactor,
} from '../src/config/resolveAmbientEffectsConfig.js';
import { regionWeight, resolveAmbientRegions, sampleAmbientRegions } from '../src/weather/ambientRegions.js';
import { findCrestAnchors } from '../src/weather/RidgePlumes.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

const LEVELS = { sea: -24, lake: -17 };

test('the shipped ambient effects resolve with every field and effect', async () => {
  const config = await loadMergedConfig();
  const settings = resolveAmbientEffectsConfig(config.ambientEffects, LEVELS);
  assert.equal(settings.enabled, true);
  const names = settings.fields.map((field) => field.name);
  for (const name of ['diamondDust', 'spindrift', 'blowingSand', 'surfSpray', 'pollen', 'seeds', 'fireflies',
    'spores', 'canopyShafts', 'midges', 'lakeMist']) {
    assert.ok(names.includes(name), `${name} is configured`);
  }
  // Named water levels become heights.
  assert.equal(settings.fields.find((field) => field.name === 'surfSpray').base, -24);
  assert.equal(settings.fields.find((field) => field.name === 'lakeMist').base, -17);
  assert.equal(settings.fields.find((field) => field.name === 'fireflies').floor, -17);
  for (const name of ['snowStreaks', 'sandStreaks', 'grassGustSheen', 'frost', 'heatShimmer', 'jungleMist']) {
    assert.equal(typeof settings[name].strength, 'number', `${name} has a strength`);
  }
  assert.equal(settings.plumes.enabled, true);
  assert.equal(settings.breath.enabled, true);
});

test('ambient effects switch off as a whole', () => {
  assert.deepEqual(resolveAmbientEffectsConfig(undefined), { enabled: false });
  assert.deepEqual(resolveAmbientEffectsConfig({ enabled: false }), { enabled: false });
  assert.deepEqual(resolveJungleMistConfig({ enabled: false }), { enabled: false });
});

test('a field fills its defaults and rejects bad values by path', () => {
  const settings = resolveAmbientEffectsConfig({ fields: { motes: { count: 10, area: 20 } } });
  const [field] = settings.fields;
  assert.equal(field.shape, 'soft');
  assert.deepEqual(field.regions, ['any']);
  assert.equal(field.base, 'ground');
  assert.equal(field.blending, 'normal');
  assert.throws(() => resolveAmbientEffectsConfig({ fields: { bad: { count: 10, area: 20, shape: 'cube' } } }),
    /ambientEffects\.fields\.bad\.shape/);
  assert.throws(() => resolveAmbientEffectsConfig({ fields: { bad: { count: 10, area: 20, region: 'moon' } } }),
    /ambientEffects\.fields\.bad\.region/);
  assert.throws(() => resolveAmbientEffectsConfig({ fields: { bad: { count: 0, area: 20 } } }),
    /ambientEffects\.fields\.bad\.count/);
  assert.throws(() => resolveAmbientEffectsConfig({ fields: { bad: { count: 10, area: 20, height: [4, 1] } } }),
    /ambientEffects\.fields\.bad\.height/);
  // A water body that is not configured cannot be floated on.
  assert.throws(() => resolveAmbientEffectsConfig({ fields: { bad: { count: 10, area: 20, base: 'sea' } } }),
    /not configured/);
  // Disabled fields are dropped.
  assert.equal(resolveAmbientEffectsConfig({ fields: { off: { enabled: false, count: 10, area: 20 } } }).fields.length, 0);
});

test('jungle mist needs its clear zone to end after it starts', () => {
  assert.throws(() => resolveJungleMistConfig({ jungleMist: { nearStart: 30, nearEnd: 10 } }), /nearEnd/);
  assert.equal(resolveJungleMistConfig({}).enabled, true);
});

test('preset weights fall back to the default and wind scales by response', () => {
  const effect = { presets: { windy: 1, calm: 0.2 }, presetDefault: 0.5 };
  assert.equal(presetWeight(effect, 'windy'), 1);
  assert.equal(presetWeight(effect, 'calm'), 0.2);
  assert.equal(presetWeight(effect, 'sunny'), 0.5);
  assert.equal(windFactor(0.3, 0), 1);
  assert.equal(windFactor(0.5, 1), 0.5);
  assert.equal(windFactor(0.5, 2), 0.25);
  // Windiness is capped so a gale cannot run an effect away.
  assert.equal(windFactor(10, 1), 2);
  assert.equal(windFactor(-1, 1), 0);
});

test('crest anchors are the highest prominent peaks, spaced apart', () => {
  const peaks = [{ x: 0, z: 0, h: 220 }, { x: 300, z: 0, h: 200 }, { x: 40, z: 0, h: 150 }];
  const height = (x, z) => Math.max(0, ...peaks.map((peak) => peak.h * Math.exp(-((x - peak.x) ** 2 + (z - peak.z) ** 2) / 2000)));
  const anchors = findCrestAnchors(height, { minX: -200, maxX: 500, minZ: -200, maxZ: 200 }, {
    minHeight: 120, step: 10, prominenceRadius: 60, minProminence: 10, spacing: 100, count: 5,
  });
  assert.equal(anchors.length, 2);
  assert.deepEqual([anchors[0].x, anchors[0].z], [0, 0]);
  assert.deepEqual([anchors[1].x, anchors[1].z], [300, 0]);
  const none = findCrestAnchors(height, { minX: -200, maxX: 500, minZ: -200, maxZ: 200 }, {
    minHeight: 500, step: 10, prominenceRadius: 60, minProminence: 10, spacing: 100, count: 5,
  });
  assert.equal(none.length, 0);
});

test('region weights find each biome at its landmark', async () => {
  const config = await loadMergedConfig();
  const regions = resolveAmbientRegions(config);
  const flat = () => 0;
  const at = (x, z, options = {}) => sampleAmbientRegions(regions, x, z, { sampleHeight: flat, ...options });
  // The meadow start: nothing but meadow.
  const start = at(2, -5);
  assert.equal(start.meadow, 1);
  assert.equal(start.sand, 0);
  // Beach South is sand and surf.
  const beach = at(990, 320);
  assert.ok(beach.sand > 0.5, `sand ${beach.sand}`);
  assert.ok(beach.surf > 0.5, `surf ${beach.surf}`);
  assert.ok(beach.meadow < 0.5);
  // The coastal jungle's centre.
  assert.ok(at(846, 340).jungle > 0.9);
  // The lake's middle is lake and water.
  const lake = at(362, 118);
  assert.equal(lake.lake, 1);
  assert.equal(lake.water, 1);
  // Snow country comes from the environment's eased weight.
  assert.equal(at(-25, -655, { snowWeight: 0.8 }).snow, 0.8);
  assert.equal(regionWeight({ meadow: 0.2, water: 0.7 }, ['meadow', 'water']), 0.7);
  assert.equal(regionWeight({ meadow: 0.2 }, ['any']), 0);
});
