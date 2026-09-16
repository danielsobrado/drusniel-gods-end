import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { PlayerController } from '../src/player/PlayerController.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

async function fixture(t, groundHeight) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.window = Object.assign(new globalThis.EventTarget(), { innerWidth: 1280 });
  globalThis.document = Object.assign(new globalThis.EventTarget(), { baseURI: 'http://localhost/' });
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete globalThis.window;
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document;
  });
  const config = await loadMergedConfig();
  config.player.animationSources = [];
  const player = new PlayerController(new THREE.Scene(), new THREE.PerspectiveCamera(),
    new globalThis.EventTarget(), config, { sampleHeight: () => groundHeight, contains: () => true }, null);
  t.after(() => player.dispose());
  return player;
}

function physicsAt(bodyY) {
  const position = { x: 950, y: bodyY, z: 0 };
  return {
    move: () => ({ grounded: true, movement: { x: 0, y: 0, z: 0 }, position }),
    setPosition() {},
    getVisualPosition: (target) => target.set(position.x, position.y, position.z),
    getBodyPosition: () => position,
    dispose() {},
  };
}

test('walking on the beach far below the spawn height does not respawn the player', async (t) => {
  const beach = -21;
  const player = await fixture(t, beach);
  const respawn = t.mock.method(player, 'spawnAtStart', () => {});

  player.physics = physicsAt(beach + player.metrics.halfHeight + player.metrics.radius);
  player.update(1 / 60);
  assert.equal(respawn.mock.callCount(), 0);

  // Falling through the ground under the player still recovers them.
  player.physics = physicsAt(beach - 40);
  player.update(1 / 60);
  assert.equal(respawn.mock.callCount(), 1);
});
