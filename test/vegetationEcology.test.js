import assert from 'node:assert/strict';
import test from 'node:test';
import { computeVegetationEcology, fractalNoise, hash2d } from '../src/grass/vegetationEcology.js';

const config = {
  path: { clearance: 1, falloff: 4 },
  terrain: { slopeStart: 0.2, slopeMax: 1 },
  moisture: {
    waterDistance: 100,
    waterWeight: 0.5,
    lowlandWeight: 0.3,
    noiseWeight: 0.2,
    lowlandExponent: 1.2,
  },
  trees: { trunkClearance: 2, trunkFalloff: 3, grassShadePenalty: 0.55 },
  density: {
    base: 0.6,
    moistureBoost: 0.3,
    macroVariation: 0.4,
    detailVariation: 0.2,
    highlandPenalty: 0.2,
  },
  height: {
    base: 0.2,
    macroWeight: 0.45,
    moistureWeight: 0.4,
    pathPenalty: 0.3,
    slopePenalty: 0.2,
    shadePenalty: 0.2,
    minGrowth: 0.45,
    maxGrowth: 1,
  },
  understory: { treeWeight: 0.8, moistureWeight: 0.4 },
};

const sample = (overrides = {}) => computeVegetationEcology({
  height01: 0.35,
  slope: 0.05,
  pathDistance: 20,
  treeShade: 0,
  nearestTreeDistance: 20,
  waterDistance: 80,
  submerged: false,
  macroNoise: 0.5,
  detailNoise: 0.5,
  ...overrides,
}, config);

test('dirt-way core excludes vegetation', () => {
  const ecology = sample({ pathDistance: 0 });
  assert.equal(ecology.path, 1);
  assert.equal(ecology.density, 0);
  assert.equal(ecology.growth, 0);
});

test('vegetation recovers smoothly away from dirt ways', () => {
  const fringe = sample({ pathDistance: 2.5 });
  const meadow = sample({ pathDistance: 20 });
  assert.ok(fringe.path > 0 && fringe.path < 1);
  assert.ok(meadow.density > fringe.density);
  assert.ok(meadow.growth > fringe.growth);
});

test('patch density does not also shrink surviving grass', () => {
  const sparse = sample({ detailNoise: 0 });
  const dense = sample({ detailNoise: 1 });
  assert.ok(dense.density > sparse.density);
  assert.equal(dense.growth, sparse.growth);
  assert.ok(sparse.growth >= config.height.minGrowth);
});

test('wet lowlands are more humid and support stronger growth than dry highlands', () => {
  const wet = sample({ height01: 0.1, waterDistance: 8, macroNoise: 0.65 });
  const dry = sample({ height01: 0.95, waterDistance: 300, macroNoise: 0.35 });
  assert.ok(wet.moisture > dry.moisture);
  assert.ok(wet.density > dry.density);
  assert.ok(wet.growth > dry.growth);
});

test('submerged terrain does not grow vegetation', () => {
  const ecology = sample({ submerged: true, waterDistance: 0, height01: 0.05 });
  assert.equal(ecology.density, 0);
  assert.equal(ecology.growth, 0);
  assert.equal(ecology.understory, 0);
});

test('tree shade trades open grass for understory', () => {
  const open = sample({ treeShade: 0, nearestTreeDistance: 20 });
  const woodland = sample({ treeShade: 0.9, nearestTreeDistance: 8 });
  assert.ok(woodland.understory > open.understory);
  assert.ok(woodland.density < open.density);
});

test('tree trunks enforce a vegetation-free root zone and recover outside it', () => {
  const root = sample({ nearestTreeDistance: 0.25, treeShade: 1 });
  const edge = sample({ nearestTreeDistance: 3.5, treeShade: 0.7 });
  const open = sample({ nearestTreeDistance: 8, treeShade: 0 });
  assert.equal(root.density, 0);
  assert.equal(root.growth, 0);
  assert.ok(root.understory > 0);
  assert.ok(edge.density > root.density);
  assert.ok(open.density > edge.density);
});

test('steep slopes suppress grass growth', () => {
  const gentle = sample({ slope: 0.05 });
  const steep = sample({ slope: 1.2 });
  assert.ok(gentle.density > 0);
  assert.equal(steep.density, 0);
  assert.equal(steep.growth, 0);
});

test('procedural noise is deterministic and seed-sensitive', () => {
  const first = fractalNoise(3.25, -1.75, 1234, 3);
  const repeated = fractalNoise(3.25, -1.75, 1234, 3);
  const different = fractalNoise(3.25, -1.75, 1235, 3);
  assert.equal(first, repeated);
  assert.notEqual(first, different);
  assert.ok(first >= 0 && first <= 1);
});

test('distribution hash is deterministic and normalized', () => {
  const first = hash2d(12, -8, 99);
  assert.equal(first, hash2d(12, -8, 99));
  assert.ok(first >= 0 && first <= 1);
  assert.notEqual(first, hash2d(13, -8, 99));
});
