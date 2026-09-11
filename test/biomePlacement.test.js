import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BiomeFootprints,
  generateBiomeRecords,
  selectDecorativeRecords,
  findSafeBiomePosition,
  validBiomeGround,
} from '../src/biome/BiomePlacement.js';

function world({ path = 0, understory = 0.1, density = 0.9, height = 2 } = {}) {
  return {
    terrain: {
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 96, y: 10, z: 96 } },
      contains: () => true,
      sampleHeight: () => height,
    },
    ecology: {
      sampleWorld: () => ({ path, understory, density, growth: 0.8, moisture: 0.2 }),
    },
    field: {
      sampleWorld: () => ({ dryness: 0.2, mass: 0.4 }),
    },
  };
}

function collect(options) {
  return [...generateBiomeRecords(options)].filter(Boolean);
}

test('cluster layout and solid IDs are independent of quality and weather', () => {
  const base = world();
  const occupied = new BiomeFootprints();
  const solids = new BiomeFootprints();
  const profile = { seed: 28411, cellSize: 32, clusterChance: 0.55 };
  const first = collect({ profile, ...base, occupied, solids, templates: {} });
  const again = collect({
    profile, ...base, occupied: new BiomeFootprints(), solids: new BiomeFootprints(), templates: {},
  });
  assert.deepEqual(first.map((r) => r.id), again.map((r) => r.id));
  assert.deepEqual(first.map((r) => [r.x, r.z, r.kind]), again.map((r) => [r.x, r.z, r.kind]));
  const decorative = selectDecorativeRecords(first, 0.35);
  assert.ok(decorative.length <= first.length);
  assert.deepEqual(first.filter((r) => !r.decorative).map((r) => r.id),
    decorative.filter((r) => !r.decorative).map((r) => r.id));
});

test('paths, water, alpine slopes and occupied footprints are rejected', () => {
  const pathWorld = world({ path: 0.9 });
  assert.equal(validBiomeGround(pathWorld.terrain, pathWorld.ecology, 4, 4), false);
  const alpine = world({ height: 96 });
  assert.equal(validBiomeGround(alpine.terrain, alpine.ecology, 4, 4, 0, -10), false);
  const wet = world({ height: -1 });
  assert.equal(validBiomeGround(wet.terrain, wet.ecology, 4, 4, 0, 0), false);
  const occupied = new BiomeFootprints();
  occupied.add({ x: 4, z: 4, radius: 2 });
  assert.equal(occupied.overlaps(4.5, 4.5, 0.5), true);
});

test('dry open cells request cactus and understory cells request shrubs', () => {
  const cactusWorld = {
    ...world({ understory: 0.1 }),
    field: { sampleWorld: () => ({ dryness: 0.7, mass: 0.4 }) },
  };
  const shrubWorld = world({ understory: 0.6 });
  const cactus = collect({
    profile: { seed: 1, cellSize: 32, clusterChance: 1 },
    ...cactusWorld, occupied: new BiomeFootprints(), solids: new BiomeFootprints(), templates: {},
  });
  const shrubs = collect({
    profile: { seed: 1, cellSize: 32, clusterChance: 1 },
    ...shrubWorld, occupied: new BiomeFootprints(), solids: new BiomeFootprints(), templates: {},
  });
  assert.ok(cactus.some((r) => r.kind === 'cactus'));
  assert.equal(cactus.some((r) => r.kind.startsWith('rock')), false);
  assert.ok(shrubs.every((r) => r.kind.startsWith('shrub')));
});

test('safe pose walks a fixed ring order and keeps the current cell when it is clear', () => {
  const { terrain, ecology } = world();
  const occupied = new BiomeFootprints();
  const current = findSafeBiomePosition({
    position: { x: 8, z: 8 }, terrain, ecology, occupied, radius: 0.7, rootToFeet: 2, groundOffset: 0.1,
  });
  assert.deepEqual([current.x, current.z], [8, 8]);
  occupied.add({ x: 8, z: 8, radius: 1 });
  const moved = findSafeBiomePosition({
    position: { x: 8, z: 8 }, terrain, ecology, occupied, radius: 0.7, rootToFeet: 2, groundOffset: 0.1,
  });
  assert.ok(moved);
  assert.ok(moved.x !== 8 || moved.z !== 8);
});
