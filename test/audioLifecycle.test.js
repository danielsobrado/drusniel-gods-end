import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioContext } from 'three';
import { AudioSystem } from '../src/audio/AudioSystem.js';

test('a pending audio resume cannot restart a disposed scene', async t => {
  let resume;
  let starts = 0;
  const context = { state: 'suspended', resume: () => new Promise(resolve => { resume = resolve; }) };
  t.mock.method(AudioContext, 'getContext', () => context);
  const audio = { initialized: true, started: false, disposed: false, enabled: false,
    ambient: { start: () => starts++ }, randomEmitters: { start: () => starts++ } };
  const pending = AudioSystem.prototype.start.call(audio);
  audio.disposed = true;
  context.state = 'running';
  resume();
  assert.equal(await pending, false);
  assert.equal(starts, 0);
  assert.equal(audio.enabled, false);
});

test('re-enabling audio restarts both ambient and random schedulers', () => {
  let ambientStarts = 0;
  let randomStarts = 0;
  let ambientStops = 0;
  let randomStops = 0;
  const audio = {
    enabled: true,
    started: true,
    currentPreset: 'sunny',
    ambient: {
      start: () => ambientStarts++,
      stopAll: () => ambientStops++,
    },
    randomEmitters: {
      start: () => randomStarts++,
      stopAll: () => randomStops++,
    },
    stopAll: AudioSystem.prototype.stopAll,
  };

  AudioSystem.prototype.setEnabled.call(audio, false);
  assert.equal(ambientStops, 1);
  assert.equal(randomStops, 1);

  AudioSystem.prototype.setEnabled.call(audio, true);
  assert.equal(ambientStarts, 1);
  assert.equal(randomStarts, 1);
});
