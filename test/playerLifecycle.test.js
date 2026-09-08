import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PlayerController } from '../src/player/PlayerController.js';
import { PlayerPhysics } from '../src/player/PlayerPhysics.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

async function fixture(t) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.window = Object.assign(new EventTarget(), { innerWidth: 1280 });
  globalThis.document = Object.assign(new EventTarget(), { baseURI: 'http://localhost/' });
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete globalThis.window;
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document;
  });
  const config = await loadMergedConfig();
  config.player.animationSources = [];
  const player = new PlayerController(new THREE.Scene(), new THREE.PerspectiveCamera(),
    new EventTarget(), config, { sampleHeight: () => 0, contains: () => true }, null);
  t.after(() => player.dispose());
  return player;
}

test('disposing during model loading releases the late model without creating physics', async t => {
  const player = await fixture(t);
  let resolveModel;
  const model = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  let geometryDisposed = 0, materialDisposed = 0;
  model.geometry.addEventListener('dispose', () => geometryDisposed++);
  model.material.addEventListener('dispose', () => materialDisposed++);
  t.mock.method(GLTFLoader.prototype, 'loadAsync', () => new Promise(resolve => { resolveModel = resolve; }));
  const physics = t.mock.method(PlayerPhysics, 'create', async () => null);
  const pending = player.loadModel();
  player.dispose();
  resolveModel({ scene: model, animations: [] });
  await pending.catch(error => assert.equal(error.name, 'AbortError'));
  assert.equal(physics.mock.callCount(), 0, 'a dead player must not start another WASM world');
  assert.equal(geometryDisposed, 1);
  assert.equal(materialDisposed, 1);
  assert.equal(player.model, null);
});

test('disposing during physics initialization releases the late WASM world', async t => {
  const player = await fixture(t);
  player.config.assets.player = null;
  let resolvePhysics;
  let disposed = 0, moves = 0;
  t.mock.method(PlayerPhysics, 'create', () => new Promise(resolve => { resolvePhysics = resolve; }));
  const pending = player.loadModel();
  player.dispose();
  resolvePhysics({ dispose: () => disposed++, setPosition: () => moves++,
    getVisualPosition: target => target.set(0, 0, 0) });
  await pending.catch(error => assert.equal(error.name, 'AbortError'));
  assert.equal(disposed, 1);
  assert.equal(moves, 0);
  assert.equal(player.physics, null);
});
