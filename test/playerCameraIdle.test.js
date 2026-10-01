import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { PlayerController } from '../src/player/PlayerController.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

function stubElement() {
  const element = new globalThis.EventTarget();
  return Object.assign(element, {
    style: {}, append() {}, appendChild() {}, remove() {}, setAttribute() {},
  });
}

// Solid half-spaces x > wallX and z > wallZ: a wall to the character's right
// and one behind it, as the camera sees it at yaw 0.
function cornerPhysics(wallX, wallZ) {
  const body = { x: 0, y: 1, z: 0 };
  return {
    getBodyPosition: () => body,
    move: () => ({ grounded: true, position: body }),
    isTerrainCollider: () => false,
    dispose() {},
    castSphere(from, to, radius) {
      const length = from.distanceTo(to);
      if (!(length > 1e-4)) return null;
      const direction = to.clone().sub(from).divideScalar(length);
      let hit = null;
      for (const [axis, wall] of [['x', wallX], ['z', wallZ]]) {
        const start = from[axis] + radius;
        if (start >= wall) return 0;
        if (direction[axis] <= 0) continue;
        const distance = (wall - start) / direction[axis];
        if (distance <= length && (hit === null || distance < hit)) hit = distance;
      }
      return hit;
    },
  };
}

async function idlePlayer(t, innerWidth) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldMatchMedia = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  globalThis.window = Object.assign(new globalThis.EventTarget(), { innerWidth });
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.document = Object.assign(new globalThis.EventTarget(), {
    baseURI: 'http://localhost/', body: stubElement(), createElement: stubElement, getElementById: () => null,
  });
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete globalThis.window;
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document;
    if (oldMatchMedia) Object.defineProperty(globalThis, 'matchMedia', oldMatchMedia); else delete globalThis.matchMedia;
  });
  const config = await loadMergedConfig();
  config.player.animationSources = [];
  const player = new PlayerController(new THREE.Scene(), new THREE.PerspectiveCamera(),
    new globalThis.EventTarget(), config, { sampleHeight: () => 0, contains: () => true }, null);
  t.after(() => player.dispose());
  player.handleResize();
  return player;
}

// A wide window puts the look target metres beside the character. Its side
// used to be taken from the camera's own rotation, so once walls pulled the
// camera in close the target flipped sides every frame and the camera spun
// in place with nothing moving.
test('an idle camera cornered by walls settles instead of looping', async t => {
  for (const [wallX, wallZ, yaw] of [[1.5, 1.2, 0], [1.5, 2.5, 0.4], [2.5, 1.2, -0.3], [1, 1, 0.8]]) {
    const player = await idlePlayer(t, 3440);
    player.physics = cornerPhysics(wallX, wallZ);
    player.cameraYaw = yaw;
    for (let i = 0; i < 720; i += 1) player.update(1 / 144);
    const camera = player.camera.position.clone();
    const target = player.cameraTarget.clone();
    let cameraPath = 0;
    let targetPath = 0;
    for (let i = 0; i < 144; i += 1) {
      player.update(1 / 144);
      cameraPath += player.camera.position.distanceTo(camera);
      targetPath += player.cameraTarget.distanceTo(target);
      camera.copy(player.camera.position);
      target.copy(player.cameraTarget);
    }
    const label = `walls x=${wallX} z=${wallZ}, yaw ${yaw}`;
    assert.ok(cameraPath < 1e-3, `${label}: camera moved ${cameraPath} m in a second`);
    assert.ok(targetPath < 1e-3, `${label}: target moved ${targetPath} m in a second`);
    assert.ok(target.x > 0, `${label}: target stays on the right of the character (${target.x})`);
  }
});
