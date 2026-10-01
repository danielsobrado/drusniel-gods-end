import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { validateSnowConfig } from '../src/config/validateSnowConfig.js';
import { SnowDeformationField } from '../src/world/SnowDeformationField.js';

const snowConfig = yaml.load(fs.readFileSync(new URL('../public/snow.yaml', import.meta.url), 'utf8'));

function terrainAt(height) {
  return {
    sampleHeight() { return height; },
  };
}

test('snow deformation spaces repeated contact stamps instead of painting a ladder trail', () => {
  const field = new SnowDeformationField(snowConfig, terrainAt(175));
  const foot = { position: { x: 0, y: 175.1, z: 0 }, radius: 0.3 };

  field.update(1 / 60, { x: 0, y: 176, z: 0 }, [foot], true);
  assert.ok(field.sampleAt(0, 0).depression > 0.2);

  foot.position.x = 0.5;
  field.update(1 / 60, { x: 0.5, y: 176, z: 0 }, [foot], true);
  assert.equal(field.sampleAt(0.5, 0).depression, 0);

  foot.position.x = 0.9;
  field.update(1 / 60, { x: 0.9, y: 176, z: 0 }, [foot], true);
  assert.ok(field.sampleAt(0.9, 0).depression > 0.2);
  field.dispose();
});

test('snow validation protects detail roughness and footprint spacing controls', () => {
  const invalidRoughness = structuredClone(snowConfig);
  invalidRoughness.ground.snow.roughness.variation = 0.6;
  assert.throws(() => validateSnowConfig(invalidRoughness), /roughness\.variation/);

  const invalidSpacing = structuredClone(snowConfig);
  invalidSpacing.ground.snow.deformation.stampSpacingScale = 0;
  assert.throws(() => validateSnowConfig(invalidSpacing), /stampSpacingScale/);
});
