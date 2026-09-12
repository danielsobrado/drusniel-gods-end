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
  assert.equal(alpineTreeAllowed(alpine.centerX, alpine.treeLine - 1, alpine.centerZ, alpine), true);
  assert.equal(alpineTreeAllowed(
    alpine.centerX + alpine.treeClearRadius + 1,
    alpine.treeLine + 30,
    alpine.centerZ,
    alpine,
  ), true);
});

test('alpine validation rejects an inverted mountain layout', () => {
  const invalid = structuredClone(config);
  invalid.terrain.alpine.rimRadius = invalid.terrain.alpine.basinRadius - 1;
  assert.throws(() => validateAlpineConfig(invalid), /rimRadius must be greater/);
});
