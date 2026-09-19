import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_BIOMES, bakeMinimap, biomeAt, createMapFrame, stampTrees } from '../src/ui/minimapBake.js';

function flatTerrain(height) {
  return {
    bounds: { min: { x: -100, y: height, z: -50 }, max: { x: 100, y: height, z: 50 } },
    sampleHeight: () => height,
  };
}

function bake(terrain, config) {
  const steps = bakeMinimap({ terrain, config, metersPerPixel: 5, rowsPerStep: 3 });
  let step = steps.next();
  let yields = 0;
  while (!step.done) { yields += 1; step = steps.next(); }
  return { map: step.value, yields };
}

test('map frame covers the terrain rectangle at the requested spacing', () => {
  const frame = createMapFrame({ min: { x: -800, z: -1100 }, max: { x: 1600, z: 800 } }, 2.5);
  assert.equal(frame.width, 960);
  assert.equal(frame.height, 760);
  assert.equal(frame.metersPerPixel, 2.5);
});

test('flat lowland bakes to meadow in steps and names the biome under a point', () => {
  const config = { water: {}, ground: {} };
  const { map, yields } = bake(flatTerrain(2), config);
  assert.equal(map.width, 40);
  assert.equal(map.height, 20);
  assert.ok(yields >= 6, 'bake should yield between row batches');
  assert.equal(biomeAt(map, 0, 0).id, 'meadow');
  assert.equal(biomeAt(map, 5000, 0), null);
  assert.ok(map.rgba.every((value, index) => index % 4 !== 3 || value === 255));
});

test('ground below sea level on the ocean side of the coast bakes to sea', () => {
  const config = { water: { sea: { enabled: true, level: -24, shoreX: -1000 } }, ground: {} };
  const { map } = bake(flatTerrain(-60), config);
  assert.equal(biomeAt(map, 0, 0).id, 'sea');
  assert.equal(MAP_BIOMES.length, new Set(MAP_BIOMES.map(biome => biome.id)).size);
});

test('tree stamps darken the map around each tree only', () => {
  const { map } = bake(flatTerrain(2), { water: {}, ground: {} });
  const pixel = (x, z) => {
    const index = (Math.floor((z - map.minZ) / map.metersPerPixel) * map.width
      + Math.floor((x - map.minX) / map.metersPerPixel)) * 4;
    return map.rgba[index + 1];
  };
  const before = [pixel(2.5, 2.5), pixel(80, 40)];
  stampTrees(map, [{ x: 2.5, z: 2.5 }], 8);
  assert.ok(pixel(2.5, 2.5) < before[0]);
  assert.equal(pixel(80, 40), before[1]);
});
