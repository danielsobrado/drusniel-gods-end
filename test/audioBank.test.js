import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  ShuffleBag,
  animationPhaseCrossed,
  regionWeight,
  trimSilentEdges,
} from '../src/audio/audioUtils.js';
import { REGION_NAMES } from '../src/weather/ambientRegions.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

const config = await loadMergedConfig();
const PUBLIC = new URL('../public/', import.meta.url);

function soundPaths(audio) {
  const paths = [audio.transition?.sound];
  for (const bed of audio.ambient ?? []) paths.push(bed.sound);
  for (const group of audio.oneShots ?? []) paths.push(...group.sounds);
  for (const value of Object.values(audio.footsteps ?? {})) if (value?.sounds) paths.push(...value.sounds);
  return paths.filter(Boolean);
}

test('animation phase crossing matches normal and wrapped clip playback', () => {
  assert.equal(animationPhaseCrossed(0.1, 0.4, 0.3, false), true);
  assert.equal(animationPhaseCrossed(0.1, 0.4, 0.05, false), false);
  assert.equal(animationPhaseCrossed(0.9, 0.1, 0.95, true), true);
  assert.equal(animationPhaseCrossed(0.9, 0.1, 0.05, true), true);
  assert.equal(animationPhaseCrossed(0.9, 0.1, 0.5, true), false);
});

test('every configured sound exists in public/', async () => {
  const paths = soundPaths(config.audio);
  assert.ok(paths.length > 50, `expected the full sound bank, got ${paths.length} paths`);
  for (const path of paths) await access(fileURLToPath(new URL(path, PUBLIC)));
});

test('every weather preset has audio levels and every region name is known', () => {
  for (const preset of Object.keys(config.presets)) assert.ok(config.audio.presets[preset], `audio.presets.${preset}`);
  for (const item of [...config.audio.ambient, ...config.audio.oneShots]) {
    for (const region of [...(item.regions ?? []), ...(item.excludeRegions ?? [])]) assert.ok(REGION_NAMES.includes(region), `${item.name}: ${region}`);
    for (const preset of item.presets ?? [item.preset].filter(Boolean)) assert.ok(config.presets[preset], `${item.name}: ${preset}`);
  }
});

test('region weight is the loudest named region, or 1 with none named', () => {
  assert.equal(regionWeight({ surf: 0.2, sand: 0.7 }, ['surf', 'sand']), 0.7);
  assert.equal(regionWeight({ surf: 0.2 }, ['jungle']), 0);
  assert.equal(regionWeight(null, undefined), 1);
});

test('the shuffle bag deals every variation before repeating, never twice in a row', () => {
  const bag = new ShuffleBag(['a', 'b', 'c', 'd']);
  let previous = null;
  for (let round = 0; round < 50; round++) {
    const dealt = new Set();
    for (let i = 0; i < 4; i++) {
      const item = bag.next();
      assert.notEqual(item, previous);
      dealt.add(item);
      previous = item;
    }
    assert.equal(dealt.size, 4);
  }
});

test('loop padding is trimmed from both ends and nothing else', () => {
  const context = { createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
  } };
  const source = context.createBuffer(2, 1000, 1000);
  source.getChannelData(0).fill(0.5, 100, 950);
  source.getChannelData(1)[99] = -0.25;
  const trimmed = trimSilentEdges(source, context);
  assert.equal(trimmed.length, 851);
  assert.equal(trimmed.getChannelData(1)[0], -0.25);
  assert.equal(trimmed.getChannelData(0)[850], 0.5);
  const full = context.createBuffer(1, 10, 1000);
  full.getChannelData(0).fill(0.2);
  assert.equal(trimSilentEdges(full, context), full);
});
