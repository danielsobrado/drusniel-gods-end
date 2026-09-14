import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FootstepAudioSystem } from '../src/audio/FootstepAudioSystem.js';

function fixture() {
  const sources = [];
  const parameter = () => ({ setTargetAtTime() {}, linearRampToValueAtTime() {} });
  const context = { currentTime: 0, createGain: () => ({ gain: parameter(), connect() {}, disconnect() {} }),
    createBufferSource: () => {
      const source = { playbackRate: parameter(), detune: parameter(), connect() {}, disconnect() {},
        start() {}, stop() { this.stopped = true; } };
      sources.push(source); return source;
    } };
  const action = { time: 0, getClip: () => ({ name: 'Walk', duration: 1 }) };
  const controls = { mixer: {}, activeAction: action, grounded: true, moving: true,
    horizontalVelocity: new THREE.Vector3(0, 0, 2), walkClipName: 'Walk', runClipName: 'Run', root: new THREE.Object3D() };
  const system = new FootstepAudioSystem({ listener: { context, getInput() {} }, controls, scene: {},
    config: { grass: { sounds: ['step'], volume: 1 }, animation: { walk: { steps: [0.2, 0.7] } },
      minStepInterval: 0.1, minPitch: 1, maxPitch: 1, footstepPredictionDistance: 0 },
    levels: { masterVolume: 1, environmentVolume: 1 } });
  system.buffers.set('step', { duration: 2 });
  return { system, controls, action, sources };
}

test('footsteps follow animation contacts and stop when movement ends', () => {
  globalThis.window = globalThis;
  const { system, controls, action, sources } = fixture();
  try {
    system.update(0.1, true);
    action.time = 0.15; system.update(0.15, true);
    assert.equal(sources.length, 0);
    action.time = 0.25; system.update(0.1, true);
    assert.equal(sources.length, 1);
    controls.moving = false;
    system.update(0.016, true);
    assert.equal(sources[0].stopped, true, 'active footstep must stop with the character');
    action.time = 0.75; system.update(0.5, true);
    assert.equal(sources.length, 1, 'residual velocity must not trigger idle footsteps');
  } finally { system.dispose(); delete globalThis.window; }
});

for (const reason of ['airborne', 'disabled', 'stalled']) test(`footsteps cancel when ${reason} and do not replay old contacts`, () => {
  globalThis.window = globalThis;
  const { system, controls, action, sources } = fixture();
  try {
    system.update(0.01, true);
    action.time = 0.25; system.update(0.2, true);
    assert.equal(sources.length, 1);
    if (reason === 'airborne') controls.grounded = false;
    system.update(reason === 'stalled' ? 2 : 0.016, reason !== 'disabled');
    assert.equal(sources[0].stopped, true);
    controls.grounded = true;
    action.time = 0.8; system.update(0.016, true);
    assert.equal(sources.length, 1);
  } finally { system.dispose(); delete globalThis.window; }
});
