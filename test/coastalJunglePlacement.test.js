import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_FILES } from '../src/config/loadConfig.js';
import { coastX } from '../src/world/CoastField.js';
import * as THREE from 'three';
import {
  classifyCoastalJungleName,
  coastalJungleEdgeKeeps,
  coastalJungleRegionCenter,
  coastalJungleRegionRadius,
  coastalJungleRegionWeight,
  coastalJungleSourceElevation,
  evaluateCoastalJunglePlacement,
  coastalJungleTileKeeps,
  mapCoastalJungleHorizontal,
  resolveCoastalJungleFrame,
  resolveCoastalJungleFrames,
} from '../src/biome/CoastalJunglePlacement.js';
import { coastalJungleProfileWeight } from '../src/world/CoastalJungleRegion.js';

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

test('coastal jungle copies the authored scene at its own scale, turned about its origin', () => {
  const frame = resolveCoastalJungleFrame({ origin: [846, 312], yaw: Math.PI });
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
  const origin = mapCoastalJungleHorizontal({ x: 0, z: 0 }, frame);
  close(origin.x, 846);
  close(origin.z, 312);
  // The reference camera stands 12 m behind the clearing and looks down -Z.
  const camera = mapCoastalJungleHorizontal({ x: 0, z: 12 }, frame);
  close(camera.x, 846);
  close(camera.z, 300);

  const a = mapCoastalJungleHorizontal({ x: -30, z: 17 }, frame);
  const b = mapCoastalJungleHorizontal({ x: 41, z: -64 }, frame);
  close(Math.hypot(a.x - b.x, a.z - b.z), Math.hypot(71, 81));

  // Positions turn exactly as instance orientations do.
  const turned = new THREE.Vector3(3, 0, -5).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
  const quarter = mapCoastalJungleHorizontal({ x: 3, z: -5 }, resolveCoastalJungleFrame({ origin: [0, 0], yaw: 0.7 }));
  close(quarter.x, turned.x);
  close(quarter.z, turned.z);

  assert.equal(resolveCoastalJungleFrame({ origin: [846] }), null);
  assert.equal(mapCoastalJungleHorizontal({ x: 1, z: 1 }, null), null);
});

test('coastal jungle keeps authored height above the source terrain', () => {
  assert.ok(Math.abs(coastalJungleSourceElevation(0, 0) - 0.65) < 1e-9);
  const x = 17.5;
  const z = -42.25;
  const y = -z;
  const expected = 0.065 * (y + 10) + 0.36 * Math.sin(x * 0.15) * Math.cos(y * 0.12) + 0.12 * Math.sin(y * 0.3);
  assert.ok(Math.abs(coastalJungleSourceElevation(x, z) - expected) < 1e-12);
});

test('coastal jungle thins across its edge band only', () => {
  assert.equal(coastalJungleEdgeKeeps(1, 0.999), true);
  assert.equal(coastalJungleEdgeKeeps(0, 0), false);
  assert.equal(coastalJungleEdgeKeeps(0.4, 0.3), true);
  assert.equal(coastalJungleEdgeKeeps(0.4, 0.5), false);

  const sea = { enabled: true, shoreX: 1000 };
  const region = { zStart: 250, zEnd: 430, inlandStart: 140, inlandEnd: 270 };
  const config = { water: { sea }, biomes: { coastalJungle: { enabled: true, region, ecology: { edgeFade: 12 } } } };
  const z = 340;
  assert.equal(coastalJungleProfileWeight(coastX(z, sea) - 205, z, config), 1);
  const edge = coastalJungleProfileWeight(coastX(z, sea) - 145, z, config);
  assert.ok(edge > 0 && edge < 1);
  assert.equal(coastalJungleProfileWeight(coastX(z, sea) - 139, z, config), 0);
  config.biomes.coastalJungle.enabled = false;
  assert.equal(coastalJungleProfileWeight(coastX(z, sea) - 205, z, config), 0);
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

test('coastal jungle skips coast evaluation outside the region and follows edited bounds', () => {
  const region = { zStart: 250, zEnd: 430, inlandStart: 140, inlandEnd: 270 };
  const sea = { get shoreX() { throw new Error('unnecessary coast evaluation'); } };
  assert.equal(coastalJungleRegionWeight(0, 20, region, sea), 0);
  assert.equal(coastalJungleRegionWeight(0, 500, region, sea), 0);
  const x = coastX(340, 1000) - 205;
  assert.equal(coastalJungleRegionWeight(x, 340, region, 1000), 1);
  region.zStart = 450;
  assert.equal(coastalJungleRegionWeight(x, 340, region, 1000), 0);
  region.zStart = '250';
  assert.equal(coastalJungleRegionWeight(x, 340, region, 1000), 1);
});

test('coastal jungle preserves reversed bounds, fade corners and inclusive hard edges', () => {
  for (const region of [
    { zStart: 100, zEnd: 200, inlandStart: 150, inlandEnd: 250 },
    { zStart: 200, zEnd: 100, inlandStart: 250, inlandEnd: 150 },
  ]) {
    const sample = (z, inland, edge) => coastalJungleRegionWeight(coastX(z, 1000) - inland, z, region, 1000, edge);
    assert.equal(sample(110, 160, 20), 0.25);
    assert.equal(sample(190, 240, 20), 0.25);
    assert.equal(sample(100, 150, 0), 1);
    assert.equal(sample(200, 250, 0), 1);
    assert.equal(sample(100, 150, 20), 0);
    assert.equal(sample(99, 150, 0), 0);
    assert.equal(sample(150, 200, 1000), 1);
  }
  assert.equal(coastalJungleRegionWeight(0, 0, { zStart: NaN }, 1000), 0);
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

test('scene copies tile the strip without overlapping', () => {
  const frames = resolveCoastalJungleFrames({ origin: [846, 312], yaw: Math.PI, tiles: [{ origin: [590, 312], yaw: Math.PI / 2 }] });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].tile, undefined);
  assert.equal(frames[1].tile, true);
  // Each copy keeps only its own 256 m square, so the two squares meet at x = 718.
  const edge = { x: 127.9, z: 0 };
  assert.ok(coastalJungleTileKeeps(edge, 256));
  assert.equal(coastalJungleTileKeeps({ x: 128.1, z: 0 }, 256), false);
  const first = mapCoastalJungleHorizontal(edge, frames[0]);
  assert.ok(Math.abs(first.x - 718.1) < 0.01);
  // A quarter turn maps source z onto world x.
  const second = mapCoastalJungleHorizontal({ x: 0, z: 127.9 }, frames[1]);
  assert.ok(Math.abs(second.x - 717.9) < 0.01);
  assert.deepEqual(resolveCoastalJungleFrames({ origin: [0, 0], tiles: [{ origin: ['x', 0] }] }), []);
});

test('jungle placement keeps plants out of the lake where the strip meets it', () => {
  const terrain = { sampleHeight: (x) => (x < 0 ? -20 : -16.8) };
  const wet = evaluateCoastalJunglePlacement({ x: -5, z: 0, terrain, waterLevel: -17 });
  const shore = evaluateCoastalJunglePlacement({ x: 5, z: 0, terrain, waterLevel: -17 });
  const noLake = evaluateCoastalJunglePlacement({ x: -5, z: 0, terrain });
  assert.equal(wet.allowed, false);
  assert.equal(noLake.allowed, true);
  assert.equal(shore.allowed, false, 'within waterClearance of the surface');
  assert.equal(evaluateCoastalJunglePlacement({ x: 5, z: 0, terrain, waterLevel: -17.5 }).allowed, true);
});
