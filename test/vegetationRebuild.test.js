import assert from 'node:assert/strict';
import test from 'node:test';
import { VegetationJob, VegetationSampleCache, createVegetationJobScheduler } from '../src/foliage/vegetationRebuild.js';
import { iterateWildGrassClumps, placeWildGrassClumps, resolveWildGrassSettings } from '../src/foliage/wildGrassPlacement.js';
import { DEFAULT_WILD_GRASS } from '../src/foliage/wildGrassPlacement.js';
import { placeMeadowDetails } from '../src/foliage/meadowPlacement.js';

const healthy = { density: 0.9, growth: 0.8, moisture: 0.55, path: 0, understory: 0.1 };

function settings() {
  return resolveWildGrassSettings({
    foliage: { wildGrass: { ...DEFAULT_WILD_GRASS } },
    presets: { sunny: { foliage: { wildGrass: { enabled: true, density: 1 } } } },
  }, 'sunny', 'ultra');
}

test('cached origin-independent samples do not change seeded placement', () => {
  const options = {
    origin: { x: 6, z: 6 },
    settings: settings(),
    variantCount: 3,
    sampleEcology: () => healthy,
    contains: () => true,
    sampleHeight: (x, _z) => 1 + x * 0.01,
    waterY: 0,
  };
  const direct = placeWildGrassClumps(options);
  const cache = new VegetationSampleCache();
  const cached = placeWildGrassClumps({ ...options, cache });
  assert.ok(direct.length > 0);
  assert.deepEqual(cached, direct);
  const again = placeWildGrassClumps({ ...options, origin: { x: 18, z: 6 }, cache });
  const uncached = placeWildGrassClumps({ ...options, origin: { x: 18, z: 6 } });
  assert.deepEqual(again, uncached);
});

test('cancelled jobs never publish incomplete buffers', () => {
  let published = false;
  let t = 0;
  const scheduler = createVegetationJobScheduler({ budgetMs: 2, now: () => t });
  function* generate() {
    for (let i = 0; i < 40; i += 1) yield i;
  }
  const pending = [];
  scheduler.replace('wildGrass', new VegetationJob({
    generate,
    consume: (item) => {
      pending.push(item);
      t += 3;
    },
    reset: () => { pending.length = 0; },
    publish: () => { published = true; },
  }));
  t = 0;
  scheduler.tick();
  scheduler.cancel('wildGrass');
  t = 50;
  scheduler.tick();
  assert.equal(published, false);
  assert.equal(scheduler.pending('wildGrass'), false);
});

test('completed jobs publish once with the collected items, then ignore stale generations', () => {
  let published = [];
  let t = 0;
  const scheduler = createVegetationJobScheduler({ budgetMs: 100, now: () => t });
  function* generate() {
    yield 1; yield 2; yield 3;
  }
  const pending = [];
  scheduler.replace('meadow', new VegetationJob({
    generate,
    consume: (item) => pending.push(item),
    reset: () => { pending.length = 0; },
    publish: () => { published = pending.slice(); },
  }));
  scheduler.tick();
  assert.deepEqual(published, [1, 2, 3]);
  const stale = new VegetationJob({
    generate: function* () { yield 9; },
    consume: () => {},
    publish: () => { published = ['stale']; },
  });
  stale.cancel();
  stale.step(Infinity, () => 0);
  assert.deepEqual(published, [1, 2, 3]);
});

test('sort, staging and bounds stay inside the CPU budget and do not publish early', () => {
  let t = 0;
  let published = false;
  const staged = [];
  const scheduler = createVegetationJobScheduler({ budgetMs: 2, now: () => t });
  const pending = [];
  scheduler.replace('wildGrass', new VegetationJob({
    generate: function* () { for (let i = 0; i < 40; i += 1) yield i; },
    consume: (item) => {
      pending.push(item);
      t += 3;
    },
    reset: () => { pending.length = 0; },
    finalize: function* () {
      pending.sort((a, b) => a - b);
      yield undefined;
      for (let i = 0; i < pending.length; i += 1) {
        staged.push(pending[i]);
        t += 3;
        yield undefined;
      }
    },
    publish: () => { published = true; },
  }));
  scheduler.tick();
  assert.equal(staged.length, 0);
  assert.equal(published, false);
  while (scheduler.pending('wildGrass') && staged.length === 0) {
    t = 0;
    scheduler.tick();
  }
  assert.equal(published, false);
  assert.ok(staged.length < 40);
  scheduler.cancel('wildGrass');
  t = 0;
  scheduler.tick();
  assert.equal(published, false);
});

test('meadow placement is deterministic for the same origin and seed', () => {
  const config = {
    cinematic: { vegetation: { patchScale: 0.035 } },
    water: { position: [0, 0, 0], sea: { enabled: false } },
    vegetation: {
      details: {
        pathThreshold: 0.36, pathDecorationChance: 0.18, pathStoneChance: 0.46,
        wetThreshold: 0.62, understoryThreshold: 0.46, minimumPlantDensity: 0.2,
        meadowPatchThreshold: -1, fernChance: 0.58, flowerChance: 0.32,
        minScale: 0.65, maxScale: 1.5, reedBaseScale: 0.82, reedMoistureScale: 0.58,
        fernBaseScale: 0.72, fernUnderstoryScale: 0.55, plantBaseScale: 0.64, plantGrowthScale: 0.72,
        hueBase: 0.12, humidityTint: 0.035, shadeTint: 0.018, saturation: 0.12,
        lightnessBase: 0.84, lightnessShadeScale: 0.85, lightnessVariation: 0.1,
      },
    },
  };
  const options = {
    origin: { x: 2, z: -5 },
    radius: 36,
    quality: 'ultra',
    config,
    stoneCount: 1,
    contains: () => true,
    sampleHeight: () => 1.2,
    sampleEcology: () => ({ density: 0.8, growth: 0.7, moisture: 0.2, path: 0, understory: 0.1 }),
    sampleRiverEdge: () => 100,
  };
  const first = placeMeadowDetails(options);
  const second = placeMeadowDetails(options);
  assert.ok(first.length > 0);
  assert.deepEqual(first, second);

  const pathOptions = {
    ...options,
    sampleEcology: () => ({ density: 0.8, growth: 0.7, moisture: 0.2, path: 0.9, understory: 0.1 }),
  };
  const coloredStones = placeMeadowDetails({ ...pathOptions, stoneHasColor: [true] });
  const texturedStones = placeMeadowDetails({ ...pathOptions, stoneHasColor: [false] });
  assert.ok(coloredStones.some((item) => item.type === 'stone'));
  assert.notDeepEqual(coloredStones, texturedStones);

  // Leaf litter, flowers and reeds have no business on snow; stones stay.
  const snowyPath = placeMeadowDetails({ ...pathOptions, sampleSnow: () => 0.9 });
  assert.ok(pathOptions.sampleEcology().path > 0 && coloredStones.some((item) => item.type === 'litter'));
  assert.ok(snowyPath.length > 0);
  assert.ok(snowyPath.every((item) => item.type === 'stone'));
  const snowyMeadow = placeMeadowDetails({ ...options, sampleSnow: () => 0.9 });
  assert.equal(snowyMeadow.length, 0);
});

test('iterator ticks do not change placed wild-grass results', () => {
  const options = {
    origin: { x: 0, z: 0 },
    settings: settings(),
    variantCount: 2,
    sampleEcology: () => healthy,
    contains: () => true,
    sampleHeight: () => 1,
  };
  assert.deepEqual([...iterateWildGrassClumps(options)].filter(Boolean), placeWildGrassClumps(options));
});
