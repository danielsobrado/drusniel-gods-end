import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { resolveGroundAntiTilingConfig } from '../src/world/GroundTextureBlend.js';
import { resolveRockSurfaceConfig } from '../src/world/RockSurface.js';

const config = yaml.load(fs.readFileSync(new URL('../public/ground-material.yaml', import.meta.url), 'utf8'));

test('ground anti-tiling uses a non-repeating secondary scale', () => {
  const antiTiling = resolveGroundAntiTilingConfig(config);
  assert.equal(antiTiling.enabled, true);
  assert.ok(antiTiling.secondaryScale > 0);
  assert.notEqual(antiTiling.secondaryScale, 1);
  assert.ok(antiTiling.blendEnd > antiTiling.blendStart);
  assert.ok(antiTiling.colorVariation > 0);
});

test('rock terrain blends two triplanar scales', () => {
  const rock = resolveRockSurfaceConfig(config);
  assert.ok(rock.triplanarScale > 0);
  assert.ok(rock.secondaryTriplanarScale > 0);
  assert.notEqual(rock.secondaryTriplanarScale, rock.triplanarScale);
  assert.ok(rock.textureBlendEnd > rock.textureBlendStart);
});

test('ground anti-tiling rejects a collapsed blend interval', () => {
  const invalid = structuredClone(config);
  invalid.ground.antiTiling.blendEnd = invalid.ground.antiTiling.blendStart;
  assert.throws(() => resolveGroundAntiTilingConfig(invalid), /blendEnd must be greater/);
});
