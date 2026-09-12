import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_FILES } from '../src/config/loadConfig.js';
import { coastX } from '../src/world/CoastField.js';
import {
  classifyCoastalJungleName,
  coastalJungleRegionCenter,
  coastalJungleRegionRadius,
  coastalJungleRegionWeight,
  createCoastalJungleSourceBounds,
  evaluateCoastalJunglePlacement,
  mapCoastalJungleHorizontal,
} from '../src/biome/CoastalJunglePlacement.js';

test('coastal jungle runtime config loads before final visual refinement', () => {
  const jungle = CONFIG_FILES.indexOf('coastal-jungle-runtime.yaml');
  assert.equal(CONFIG_FILES.includes('coastal-jungle.yaml'), false);
  assert.ok(jungle > CONFIG_FILES.indexOf('reference-biome.yaml'));
  assert.ok(jungle < CONFIG_FILES.indexOf('visual-refinement.yaml'));
});

test('coastal jungle recognizes authored forest groups and hero objects', () => {
  assert.equal(classifyCoastalJungleName('background_tree_01_instances'), 'background_tree');
  assert.equal(classifyCoastalJungleName('ForegroundPalm_2'), 'palm');
  assert.equal(classifyCoastalJungleName('DistantUnderstory_044'), 'shrub');
  assert.equal(classifyCoastalJungleName('Hero_split_leaf_1'), 'split_leaf');
  assert.equal(classifyCoastalJungleName('ForestPath'), null);
});

test('coastal jungle remaps authored composition relative to the live coast', () => {
  const bounds = createCoastalJungleSourceBounds([
    { x: 0, z: 0 },
    { x: 10, z: 20 },
  ]);
  const region = {
    zStart: 100,
    zEnd: 200,
    inlandStart: 150,
    inlandEnd: 250,
  };
  const mapped = mapCoastalJungleHorizontal({ x: 5, z: 10 }, bounds, region, 1000);
  assert.equal(mapped.z, 150);
  assert.equal(mapped.inland, 200);
  assert.ok(Math.abs(mapped.x - (coastX(150, 1000) - 200)) < 1e-9);
});

test('coastal jungle region center and radius cover the curved target strip', () => {
  const region = {
    zStart: 250,
    zEnd: 430,
    inlandStart: 140,
    inlandEnd: 270,
  };
  const center = coastalJungleRegionCenter(region, 1000);
  const radius = coastalJungleRegionRadius(region, 1000);
  assert.ok(center);
  assert.ok(radius > 100);

  for (const z of [region.zStart, region.zEnd]) {
    for (const inland of [region.inlandStart, region.inlandEnd]) {
      const x = coastX(z, 1000) - inland;
      assert.ok(Math.hypot(x - center.x, z - center.z) <= radius + 1e-9);
    }
  }
});

test('coastal jungle region weight fades generic ecology at biome edges', () => {
  const region = { zStart: 250, zEnd: 430, inlandStart: 140, inlandEnd: 270 };
  const z = 340;
  assert.equal(coastalJungleRegionWeight(coastX(z, 1000) - 205, z, region, 1000, 18), 1);
  assert.equal(coastalJungleRegionWeight(coastX(z, 1000) - 100, z, region, 1000, 18), 0);
  const edge = coastalJungleRegionWeight(coastX(z, 1000) - 145, z, region, 1000, 18);
  assert.ok(edge > 0 && edge < 1);
});

test('coastal jungle rejects existing routes and excessive terrain slope', () => {
  const flatTerrain = {
    contains: () => true,
    sampleHeight: (x) => 5 + x * 0.05,
  };
  const clear = evaluateCoastalJunglePlacement({
    x: 10,
    z: 20,
    terrain: flatTerrain,
    expansion: { paths: { sample: () => 0 }, river: { sample: () => ({ edge: 50 }) } },
    settings: { maxSlope: 0.2, routeMaskMax: 0.08, riverClearance: 10, slopeSampleDistance: 2 },
  });
  assert.equal(clear.allowed, true);
  assert.equal(clear.height, 5.5);

  const route = evaluateCoastalJunglePlacement({
    x: 10,
    z: 20,
    terrain: flatTerrain,
    expansion: { paths: { sample: () => 0.2 }, river: { sample: () => ({ edge: 50 }) } },
    settings: { maxSlope: 0.2, routeMaskMax: 0.08, riverClearance: 10, slopeSampleDistance: 2 },
  });
  assert.equal(route.allowed, false);

  const steepTerrain = {
    contains: () => true,
    sampleHeight: (x) => x,
  };
  const steep = evaluateCoastalJunglePlacement({
    x: 10,
    z: 20,
    terrain: steepTerrain,
    settings: { maxSlope: 0.75, slopeSampleDistance: 2 },
  });
  assert.equal(steep.allowed, false);
});
