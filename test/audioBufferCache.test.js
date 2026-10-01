import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { AudioSystem } from '../src/audio/AudioSystem.js';

const node = () => ({
  connect() {}, disconnect() {},
  gain: { value: 1, setTargetAtTime() {}, cancelScheduledValues() {}, linearRampToValueAtTime() {}, setValueAtTime() {} },
});
const fakeContext = {
  state: 'suspended', currentTime: 0, destination: {},
  createGain: node, createPanner: () => ({ ...node(), setPosition() {}, setOrientation() {} }),
  createBufferSource: node,
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createAudio(t) {
  t.mock.method(THREE.AudioContext, 'getContext', () => fakeContext);
  globalThis.document ??= { baseURI: 'http://localhost/' };
  const audio = new AudioSystem({
    camera: new THREE.PerspectiveCamera(),
    config: { audio: { masterVolume: 1, ambientVolume: 1, environmentVolume: 1, footsteps: {} }, assets: { audio: {} } },
  });
  const loads = [];
  audio.loader.loadAsync = (url) => { const load = { url, ...deferred() }; loads.push(load); return load.promise; };
  // Every consumer receives the same loader function.
  return { audio, loads, loadBuffer: audio.footsteps.loadBuffer };
}

test('concurrent requests for one sound decode it once', async (t) => {
  const { loads, loadBuffer } = createAudio(t);
  const first = loadBuffer('Assets/Audio/bird.mp3');
  const second = loadBuffer('Assets/Audio/bird.mp3');
  loadBuffer('Assets/Audio/other.mp3');
  assert.equal(loads.length, 2);
  const buffer = { duration: 1 };
  loads[0].resolve(buffer);
  assert.equal(await first, buffer);
  assert.equal(await second, buffer);
  assert.equal(await loadBuffer('Assets/Audio/bird.mp3'), buffer);
  assert.equal(loads.length, 2);
});

test('a failed sound yields null and is retried later', async (t) => {
  const { loads, loadBuffer } = createAudio(t);
  t.mock.method(console, 'warn', () => {});
  const failed = loadBuffer('Assets/Audio/bird.mp3');
  loads[0].reject(new Error('decode'));
  assert.equal(await failed, null);
  const retry = loadBuffer('Assets/Audio/bird.mp3');
  assert.equal(loads.length, 2);
  loads[1].resolve({ duration: 1 });
  assert.deepEqual(await retry, { duration: 1 });
});

test('a buffer decoded after disposal is not handed out', async (t) => {
  const { audio, loads, loadBuffer } = createAudio(t);
  const pending = loadBuffer('Assets/Audio/bird.mp3');
  audio.dispose();
  loads[0].resolve({ duration: 1 });
  assert.equal(await pending, null);
  assert.equal(audio.buffers.size, 0);
});
