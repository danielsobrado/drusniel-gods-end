import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { SnowDeformationField, sampleSnowCoverageCpu } from '../src/world/SnowDeformationField.js';
import { resolveSnowPowderConfig } from '../src/world/SnowPowderSystem.js';
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

test('snow deformation preserves tracks across deferred recentering', () => {
  const field = new SnowDeformationField(snowConfig, terrainAt(175));
  const origin = { x: 0, y: 176, z: 0 };
  field.update(1 / 60, origin, [{ position: { x: 0, y: 175.1, z: 0 }, radius: 0.3 }], true);
  const fresh = field.sampleAt(0, 0).depression;
  assert.ok(fresh > 0);

  field.update(0, { x: 1, y: 176, z: 0 }, [], false);
  assert.equal(field.center.x, 0);
  field.update(0, { x: 9, y: 176, z: 0 }, [], false);
  assert.ok(field.center.x >= 8 && field.center.x <= 9);
  assert.equal(field.sampleAt(0, 0).depression, fresh);

  field.update(0, { x: 1000, y: 176, z: 0 }, [], false);
  assert.equal(field.sampleAt(0, 0).depression, 0);
  field.dispose();
});

test('snow normal gradients are cleared when their depression has recovered', () => {
  const config = structuredClone(snowConfig);
  config.ground.snow.deformation.depressionStrength = 0.02;
  const field = new SnowDeformationField(config, terrainAt(175));
  const player = { x: 0, y: 176, z: 0 };
  field.update(1 / 60, player, [{ position: { x: 0, y: 175.1, z: 0 }, radius: 0.3 }], true);

  let candidate = -1;
  for (let offset = 0; offset < field.pixels.length; offset += 4) {
    if (field.pixels[offset] === 2
      && (field.pixels[offset + 2] !== 128 || field.pixels[offset + 3] !== 128)) {
      candidate = offset;
      break;
    }
  }
  assert.notEqual(candidate, -1);

  field.update(field.config.recoveryInterval, player, [], false);
  field.update(field.config.recoveryInterval, player, [], false);
  assert.equal(field.pixels[candidate], 0);
  assert.equal(field.pixels[candidate + 2], 128);
  assert.equal(field.pixels[candidate + 3], 128);
  field.dispose();
});

test('snow deformation samples outside its local window as empty', () => {
  const field = new SnowDeformationField(snowConfig, terrainAt(175));
  field.update(0, { x: 0, y: 176, z: 0 }, [], false);
  const row = Math.floor(field.config.resolution / 2);
  const edge = (row * field.config.resolution + field.config.resolution - 1) * 4;
  field.pixels[edge] = 255;
  assert.deepEqual(field.sampleAt(field.config.worldSize, 0), {
    depression: 0,
    berm: 0,
    gradientX: 0,
    gradientZ: 0,
  });
  field.dispose();
});

test('snow powder config resolves the configured local particle budget', () => {
  const powder = resolveSnowPowderConfig(snowConfig.ground.snow.powder);
  assert.equal(powder.enabled, true);
  assert.equal(powder.capacity, 144);
  assert.equal(powder.particlesPerContact, 8);
  assert.ok(powder.lifetime.max >= powder.lifetime.min);
  assert.ok(powder.size.max >= powder.size.min);
});

test('snow validation rejects invalid accumulation, deformation and powder settings', () => {
  const invalid = structuredClone(snowConfig);
  invalid.ground.snow.altitude.full = invalid.ground.snow.altitude.start;
  invalid.ground.snow.deformation.resolution = 16;
  assert.throws(() => validateSnowConfig(invalid), /Snow configuration is invalid/);

  const fractionalResolution = structuredClone(snowConfig);
  fractionalResolution.ground.snow.deformation.resolution = 512.5;
  assert.throws(() => validateSnowConfig(fractionalResolution), /resolution must be an integer/);

  const unsafeWindow = structuredClone(snowConfig);
  unsafeWindow.ground.snow.deformation.recenterDistance = 31.5;
  assert.throws(() => validateSnowConfig(unsafeWindow), /maximum footprint berm/);

  const invalidPowderRange = structuredClone(snowConfig);
  invalidPowderRange.ground.snow.powder.sizeMin = 0.5;
  invalidPowderRange.ground.snow.powder.sizeMax = 0.2;
  assert.throws(() => validateSnowConfig(invalidPowderRange), /sizeMax must be greater/);

  const invalidPowderBudget = structuredClone(snowConfig);
  invalidPowderBudget.ground.snow.powder.capacity = 144.5;
  assert.throws(() => validateSnowConfig(invalidPowderBudget), /capacity must be an integer/);
});
