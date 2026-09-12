import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { SnowDeformationField, sampleSnowCoverageCpu } from '../src/world/SnowDeformationField.js';
import { validateSnowConfig } from '../src/config/validateSnowConfig.js';

const snowConfig = yaml.load(fs.readFileSync(new URL('../public/snow.yaml', import.meta.url), 'utf8'));
validateSnowConfig(snowConfig);

function terrainAt(height) {
  return {
    sampleHeight() { return height; },
  };
}

test('snow coverage accumulates on high upward terrain and clears in lowlands and cliffs', () => {
  const high = sampleSnowCoverageCpu(-15, 175, -710, 1, snowConfig);
  const low = sampleSnowCoverageCpu(0, 20, 0, 1, snowConfig);
  const cliff = sampleSnowCoverageCpu(-15, 175, -710, 0.15, snowConfig);
  assert.ok(high > 0.9);
  assert.equal(low, 0);
  assert.equal(cliff, 0);
});

test('snow deformation paints contacted snow and decays over time', () => {
  const field = new SnowDeformationField(snowConfig, terrainAt(175));
  const player = { x: 0, y: 176, z: 0 };
  const foot = { position: { x: 0, y: 175.1, z: 0 }, radius: 0.45 };
  field.update(1 / 60, player, [foot], true);
  const fresh = field.sampleAt(0, 0);
  assert.ok(fresh.depression > 0.2);
  assert.ok(fresh.berm >= 0);

  field.update(90, player, [], false);
  const aged = field.sampleAt(0, 0);
  assert.ok(aged.depression < fresh.depression);
  field.dispose();
});

test('snow deformation does not paint a swinging foot above the surface', () => {
  const field = new SnowDeformationField(snowConfig, terrainAt(175));
  const player = { x: 0, y: 176, z: 0 };
  const raisedFoot = { position: { x: 0, y: 177, z: 0 }, radius: 0.3 };
  field.update(1 / 60, player, [raisedFoot], true);
  assert.equal(field.sampleAt(0, 0).depression, 0);
  field.dispose();
});

test('snow deformation rejects footprints below the accumulation band', () => {
  const field = new SnowDeformationField(snowConfig, terrainAt(20));
  const player = { x: 0, y: 21, z: 0 };
  field.update(1 / 60, player, [{ position: { x: 0, y: 20.1, z: 0 }, radius: 0.3 }], true);
  assert.equal(field.sampleAt(0, 0).depression, 0);
  field.dispose();
});

test('snow validation rejects invalid accumulation and deformation settings', () => {
  const invalid = structuredClone(snowConfig);
  invalid.ground.snow.altitude.full = invalid.ground.snow.altitude.start;
  invalid.ground.snow.deformation.resolution = 16;
  assert.throws(() => validateSnowConfig(invalid), /Snow configuration is invalid/);
});
