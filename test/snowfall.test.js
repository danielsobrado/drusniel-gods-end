import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { MathUtils } from 'three';
import { resolveSnowfallConfig } from '../src/config/resolveSnowfallConfig.js';
import { validateSnowConfig } from '../src/config/validateSnowConfig.js';
import { sampleSnowCoverageCpu } from '../src/world/SnowDeformationField.js';

const snowConfig = yaml.load(fs.readFileSync(new URL('../public/snow.yaml', import.meta.url), 'utf8'));
const snowfall = resolveSnowfallConfig(snowConfig.ground.snow.snowfall);

function intensityAt(x, y, z, normalY = 1) {
  const coverage = sampleSnowCoverageCpu(x, y, z, normalY, snowConfig);
  return MathUtils.smoothstep(coverage, snowfall.minCoverage, snowfall.fullCoverage) * snowfall.maxIntensity;
}

test('snowfall falls on the alpine summit and not on the lowlands or a bare cliff', () => {
  assert.equal(snowfall.enabled, true);
  assert.ok(intensityAt(-15, 175, -710) > 0.9, 'the snow basin is snowing');
  assert.equal(intensityAt(0, 20, 0), 0, 'lowland grass stays clear');
  assert.equal(intensityAt(-15, 175, -710, 0.15), 0, 'a scoured cliff face stays clear');
});

test('snowfall validation rejects an inverted coverage ramp and column', () => {
  const invertedRamp = structuredClone(snowConfig);
  invertedRamp.ground.snow.snowfall.fullCoverage = invertedRamp.ground.snow.snowfall.minCoverage;
  assert.throws(() => validateSnowConfig(invertedRamp), /snowfall\.fullCoverage/);

  const invertedColumn = structuredClone(snowConfig);
  invertedColumn.ground.snow.snowfall.top = invertedColumn.ground.snow.snowfall.bottom - 1;
  assert.throws(() => validateSnowConfig(invertedColumn), /snowfall\.top/);
});
