import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { validateAlpineConfig } from '../src/config/validateAlpineConfig.js';
import {
  alpineTreeAllowed,
  resolveAlpineConfig,
  shapeAlpineHeight,
} from '../src/world/AlpineRegion.js';

const config = yaml.load(fs.readFileSync(new URL('../public/alpine.yaml', import.meta.url), 'utf8'));
validateAlpineConfig(config);
const alpine = resolveAlpineConfig(config);

test('alpine summit forms a snowy basin with a higher mountain rim', () => {
  const baseline = 90;
  const center = shapeAlpineHeight(alpine.centerX, alpine.centerZ, baseline, alpine);
  assert.ok(center >= alpine.basinHeight - alpine.detailAmplitude);
  assert.ok(center <= alpine.basinHeight + alpine.basinRelief + alpine.detailAmplitude);

  for (let index = 0; index < 8; index += 1) {
    const angle = index / 8 * Math.PI * 2;
    const x = alpine.centerX + Math.cos(angle) * alpine.rimRadius;
    const z = alpine.centerZ + Math.sin(angle) * alpine.rimRadius;
    const rim = shapeAlpineHeight(x, z, baseline, alpine);
    assert.ok(rim > center + 30, `rim sample ${index} must rise above the summit basin`);
  }
});

test('alpine shaping blends back to the existing landscape outside the region', () => {
  const baseline = 117.5;
  const x = alpine.centerX + alpine.outerRadius + 5;
  assert.equal(shapeAlpineHeight(x, alpine.centerZ, baseline, alpine), baseline);
});

test('alpine treeline clears high trees but preserves low and distant forest', () => {
  assert.equal(alpineTreeAllowed(alpine.centerX, alpine.treeLine + 1, alpine.centerZ, alpine), false);
  assert.equal(alpineTreeAllowed(alpine.centerX, alpine.treeLine - 31, alpine.centerZ, alpine), true);
  assert.equal(alpineTreeAllowed(
    alpine.centerX + alpine.treeClearRadius + 1,
    alpine.treeLine + 30,
    alpine.centerZ,
    alpine,
  ), true);
});

// The expanded landscape meshes the cirque on a 2.5 m grid, so relief shorter
// than about eight cells cannot be drawn: it arrives as flat triangles and a
// crest that zig-zags from vertex to vertex. `landform.relief.octaves` is the
// budget that keeps the field inside it, and this measures what it buys: the
// mean slope break between neighbouring cells across the cirque.
test('cirque relief stays inside what the terrain grid can carry', () => {
  const withOctaves = (octaves) => ({
    ...alpine,
    landform: { ...alpine.landform, relief: { ...alpine.landform.relief, octaves } },
  });
  const meanSlopeBreak = (settings) => {
    const step = 2.5;
    let total = 0;
    let count = 0;
    const height = (x, z) => shapeAlpineHeight(x, z, 90, settings);
    for (let z = settings.centerZ - 200; z <= settings.centerZ + 200; z += step) {
      for (let x = settings.centerX - 200; x <= settings.centerX + 200; x += step) {
        if (Math.hypot(x - settings.centerX, z - settings.centerZ) > 200) continue;
        const middle = height(x, z);
        const alongX = height(x - step, z) - 2 * middle + height(x + step, z);
        const alongZ = height(x, z - step) - 2 * middle + height(x, z + step);
        total += Math.atan2(Math.hypot(alongX, alongZ), step) * 180 / Math.PI;
        count += 1;
      }
    }
    return total / count;
  };
  assert.ok(meanSlopeBreak(alpine) < 21, 'configured relief must stay under 21 degrees of break per cell');
  assert.ok(meanSlopeBreak(withOctaves(5)) > 24, 'the unbudgeted relief is what the budget guards against');
});

test('alpine validation rejects an inverted mountain layout', () => {
  const invalid = structuredClone(config);
  invalid.terrain.alpine.rimRadius = invalid.terrain.alpine.basinRadius - 1;
  assert.throws(() => validateAlpineConfig(invalid), /rimRadius must be greater/);
});
