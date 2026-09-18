import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';
import { LandscapePaths, cutWallRise } from '../src/world/LandscapePaths.js';
import { ALPINE_CONIFER_SNOW, alpineTreeAllowed, resolveAlpineConfig } from '../src/world/AlpineRegion.js';
import { sampleSnowCoverageCpu, snowSlopePatchCpu } from '../src/world/SnowDeformationField.js';

const snowConfig = yaml.load(fs.readFileSync(new URL('../public/snow.yaml', import.meta.url), 'utf8'));
const alpineConfig = yaml.load(fs.readFileSync(new URL('../public/alpine.yaml', import.meta.url), 'utf8'));

const flatNoise = { slope: 0, gully: 0, bench: 0, benchMask: 0, phase: 0, rough: 0 };
const cut = { floorHalf: 7, slope: 1.8, slopeVariation: 0.3, fillSlope: 0.9, toe: 6, meander: 7, benchHeight: 11, benchFraction: 0.5, roughness: 2.5 };

// A straight route across a ridge far higher than its grade allows.
function ridgeCrossing(routeCut) {
  const ridge = (_x, z) => 180 * Math.exp(-((z / 60) ** 2));
  const route = { name: 'Ridge', width: 5, walkable: true, terrainWidth: 14, maxGrade: 0.2, cut: routeCut, points: [[0, -300], [0, 0], [0, 300]] };
  const paths = new LandscapePaths(1000, 1000, 0, 0, false, [route], ridge);
  return { paths, height: (x, z) => paths.conformHeight(x, z, ridge(x, z)) };
}

test('a cut wall rises from the floor at its mean slope and steps into benches', () => {
  assert.equal(cutWallRise(0, cut, flatNoise), 0);
  assert.equal(cutWallRise(-3, cut, flatNoise), 0);
  // The toe bends the floor into the wall instead of creasing it.
  assert.ok(cutWallRise(1, cut, flatNoise) < 0.5);
  const smooth = cutWallRise(60, cut, flatNoise);
  assert.ok(Math.abs(smooth - cut.slope * (60 - cut.toe / 2)) < 1e-9);

  const terraced = { ...flatNoise, benchMask: 1 };
  let previous = 0;
  const steps = [];
  for (let run = 0; run <= 60; run += 0.5) {
    const rise = cutWallRise(run, cut, terraced);
    assert.ok(rise >= previous - 1e-9, `wall descends at ${run} m`);
    steps.push(rise - previous);
    previous = rise;
  }
  // Benches are near flat and risers steeper than the mean.
  const upper = steps.slice(40);
  assert.ok(Math.min(...upper) < cut.slope * 0.5 * 0.2);
  assert.ok(Math.max(...upper) > cut.slope * 0.5 * 1.3);
});

test('a graded route through a high ridge opens a gorge instead of a sheer slot', () => {
  const { height } = ridgeCrossing({ floorWidth: 14, toe: 6, slope: 1.8, slopeVariation: 0.3, meander: 7, benchHeight: 11, roughness: 2.5 });
  const floor = height(0, 0);
  assert.ok(180 - floor > 100, 'the route cuts deep through the crest');
  for (const side of [-1, 1]) {
    // Flat floor, then a wall no steeper on average than the configured slope
    // plus its variation, not the 100 m drop in a few metres of the old blend.
    assert.ok(Math.abs(height(side * 5, 0) - floor) < 0.2);
    for (let run = 10; run <= 60; run += 10) {
      const rise = height(side * run, 0) - floor;
      assert.ok(rise < 1.8 * 1.3 * (run - 7) + 16, `rise ${rise.toFixed(1)} at ${run} m`);
    }
    // Well out the wall meets the untouched ridge.
    assert.ok(Math.abs(height(side * 200, 0) - 180) < 1);
  }
});

test('routes without a cut profile keep the narrow terrain blend', () => {
  const { height } = ridgeCrossing(undefined);
  const floor = height(0, 0);
  assert.ok(height(10, 0) - floor > 150);
});

test('slope noise moves the snow line on steep ground in patches', () => {
  let low = Infinity, high = -Infinity;
  for (let x = -400; x <= 400; x += 7) for (let z = -400; z <= 400; z += 11) {
    const patch = snowSlopePatchCpu(x, z);
    low = Math.min(low, patch); high = Math.max(high, patch);
  }
  assert.ok(low >= -1 && high <= 1 && low < -0.5 && high > 0.5);

  const steep = 0.6;
  const covers = [];
  for (let x = -300; x <= 300; x += 13) covers.push(sampleSnowCoverageCpu(x, 190, -650, steep, snowConfig));
  assert.ok(Math.max(...covers) - Math.min(...covers) > 0.3, 'the same slope holds snow in some places and not others');
  const flat = structuredClone(snowConfig);
  flat.ground.snow.slope.noise = 0;
  const even = [-200, 0, 200].map((x) => sampleSnowCoverageCpu(x, 190, -650, 0.99, flat));
  assert.ok(even.every((value) => value > 0.99));
});

test('broadleaf trees give way to conifers on snow below the tree line', () => {
  const alpine = resolveAlpineConfig(alpineConfig);
  const { centerX: x, centerZ: z } = alpine;
  assert.ok(alpineTreeAllowed(x, alpine.treeLine - 10, z, alpine, 0));
  assert.equal(alpineTreeAllowed(x, alpine.treeLine - 10, z, alpine, ALPINE_CONIFER_SNOW + 0.1), false);
  assert.equal(alpineTreeAllowed(x, alpine.treeLine + 10, z, alpine, 0), false);
  assert.ok(alpineTreeAllowed(x + alpine.treeClearRadius + 5, 150, z, alpine, 1));
});
