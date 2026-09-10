import assert from 'node:assert/strict';
import test from 'node:test';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';
import {
  resolvePresetConfig,
  setReferenceBiomeEnabled,
  isReferencePreset,
} from '../src/config/resolvePresetConfig.js';

const UNTOUCHED = ['goldenHour', 'rainy', 'calm', 'bowed', 'moonlight'];

function fixture() {
  return {
    cinematic: { enabled: true, style: { grassFill: 0.06, meadowPatchScale: 0.035 } },
    biomes: { referenceScrub: { enabled: false, seed: 28411 } },
    presets: {
      sunny: {
        biomeProfile: 'referenceScrub',
        grass: { blade: { bladeHeight: 2.5 } },
        lighting: { position: [0, 30, 45] },
        referenceLook: { grass: { blade: { bladeHeight: 1.3 } }, style: { grassFill: 0.04 } },
      },
      windy: {
        biomeProfile: 'referenceScrub',
        grass: { blade: { bladeHeight: 1.5 } },
        referenceLook: { grass: { blade: { bladeHeight: 1.2 } } },
      },
      goldenHour: { grass: { blade: { bladeHeight: 1.5 } } },
    },
  };
}

test('only sunny and windy receive a reference biome profile', async () => {
  const config = await loadMergedConfig();
  assert.equal(isReferencePreset(config, 'sunny'), true);
  assert.equal(isReferencePreset(config, 'windy'), true);
  for (const name of UNTOUCHED) assert.equal(isReferencePreset(config, name), false);
  assert.equal(config.ui.initialPreset, 'goldenHour');
  assert.equal(config.biomes.referenceScrub.enabled, false);
  assert.equal(config.biomes.referenceScrub.seed, 28411);
});

test('disabled biome restores original preset values without mutating input', () => {
  const config = fixture();
  const original = structuredClone(config);
  const sunny = resolvePresetConfig(config, 'sunny');
  sunny.grass.blade.bladeHeight = 99;
  sunny.lighting.position[0] = 123;
  assert.equal(config.presets.sunny.grass.blade.bladeHeight, 2.5);
  assert.deepEqual(config.presets.sunny.lighting.position, [0, 30, 45]);
  assert.equal(sunny.activeBiome, null);
  assert.equal(resolvePresetConfig(config, 'sunny').grass.blade.bladeHeight, 2.5);
  assert.deepEqual(config, original);
});

test('enabled biome merges referenceLook only onto the selected presets', () => {
  const config = fixture();
  setReferenceBiomeEnabled(config, true);
  const sunny = resolvePresetConfig(config, 'sunny');
  const windy = resolvePresetConfig(config, 'windy');
  const golden = resolvePresetConfig(config, 'goldenHour');
  assert.equal(sunny.grass.blade.bladeHeight, 1.3);
  assert.equal(windy.grass.blade.bladeHeight, 1.2);
  assert.equal(golden.grass.blade.bladeHeight, 1.5);
  assert.equal(sunny.style.grassFill, 0.04);
  assert.equal(config.cinematic.style.grassFill, 0.06);
  assert.equal(config.presets.sunny.grass.blade.bladeHeight, 2.5);
  setReferenceBiomeEnabled(config, false);
  assert.equal(resolvePresetConfig(config, 'sunny').grass.blade.bladeHeight, 2.5);
});

test('merged config keeps original sunny blade height until the biome is enabled', async () => {
  const config = await loadMergedConfig();
  assert.equal(config.presets.sunny.grass.blade.bladeHeight, 2.5);
  assert.equal(resolvePresetConfig(config, 'sunny').grass.blade.bladeHeight, 2.5);
  setReferenceBiomeEnabled(config, true);
  assert.equal(resolvePresetConfig(config, 'sunny').grass.blade.bladeHeight, 1.3);
  assert.equal(resolvePresetConfig(config, 'windy').grass.blade.bladeHeight, 1.2);
  assert.equal(resolvePresetConfig(config, 'rainy').rain, true);
  assert.equal(config.presets.sunny.grass.blade.bladeHeight, 2.5);
});
