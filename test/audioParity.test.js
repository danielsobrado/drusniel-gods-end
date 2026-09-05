import test from 'node:test';
import assert from 'node:assert/strict';
import {
  animationPhaseCrossed,
  classifyTerrainBlend,
} from '../src/audio/audioUtils.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

const config = await loadMergedConfig();

test('animation phase crossing matches normal and wrapped clip playback', () => {
  assert.equal(animationPhaseCrossed(0.1, 0.4, 0.3, false), true);
  assert.equal(animationPhaseCrossed(0.1, 0.4, 0.05, false), false);
  assert.equal(animationPhaseCrossed(0.9, 0.1, 0.95, true), true);
  assert.equal(animationPhaseCrossed(0.9, 0.1, 0.05, true), true);
  assert.equal(animationPhaseCrossed(0.9, 0.1, 0.5, true), false);
});

test('terrain blend threshold preserves recovered grass and mud classification', () => {
  assert.equal(classifyTerrainBlend(0.499, 0.5), 'grass');
  assert.equal(classifyTerrainBlend(0.5, 0.5), 'mud');
  assert.equal(classifyTerrainBlend(0.501, 0.5), 'mud');
});

test('merged configuration contains recovered spatial audio parameters', () => {
  assert.equal(config.audio.masterVolume, 1);
  assert.equal(config.audio.ambientVolume, 0.35);
  assert.equal(config.audio.environmentVolume, 1);
  assert.equal(config.audio.presetFadeDuration, 1.5);
  assert.deepEqual(config.audio.emitters[0].position, [250, 0, 149]);
  assert.equal(config.audio.emitters[0].refDistance, 110);
  assert.equal(config.audio.randomEmitters.birds.count, 100);
  assert.equal(config.audio.randomEmitters.birds.radius, 100);
  assert.deepEqual(config.audio.footsteps.grass.sounds, [
    'Assets/Audio/grass-footstep4.mp3',
    'Assets/Audio/grass-footstep5.mp3',
    'Assets/Audio/grass-footstep6.mp3',
  ]);
  assert.deepEqual(config.audio.footsteps.animation.walk.steps, [
    0.059880239520958084,
    0.30538922155688625,
    0.5508982035928144,
    0.7964071856287425,
  ]);
  assert.equal(config.audio.presets.rainy.randomEmitters.volumeMultiplier, 0);
  assert.equal(config.audio.presets.moonlight.randomEmitters.volumeMultiplier, 0);
});
