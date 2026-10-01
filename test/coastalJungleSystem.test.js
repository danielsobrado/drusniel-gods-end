import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CoastalJungleSystem } from '../src/biome/CoastalJungleSystem.js';

test('coastal jungle initialization does not block application startup', async (t) => {
  const originalDocument = globalThis.document;
  const originalLoadAsync = GLTFLoader.prototype.loadAsync;
  let resolveLoad;

  globalThis.document = { baseURI: 'https://example.invalid/' };
  GLTFLoader.prototype.loadAsync = () => new Promise((resolve) => { resolveLoad = resolve; });

  t.after(() => {
    GLTFLoader.prototype.loadAsync = originalLoadAsync;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });

  const controller = new AbortController();
  const system = new CoastalJungleSystem({
    scene: new THREE.Scene(),
    config: {
      biomes: { coastalJungle: { enabled: true, asset: 'Assets/coastal-jungle.glb' } },
      water: { sea: { enabled: true } },
      ui: { initialQuality: 'high' },
    },
    terrain: {},
  });

  assert.equal(system.init(controller.signal), system);
  assert.equal(system.ready, false);
  assert.ok(system.initTask instanceof Promise);

  system.dispose();
  resolveLoad({ scene: new THREE.Group() });
  await system.initTask;
  assert.equal(system.ready, false);
});
