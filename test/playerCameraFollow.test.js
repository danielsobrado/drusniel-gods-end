import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { PlayerController } from '../src/player/PlayerController.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

// Just enough DOM for MobileControls to build its overlay in Node.
function stubElement() {
  const element = new globalThis.EventTarget();
  return Object.assign(element, {
    style: {}, append() {}, appendChild() {}, remove() {}, setAttribute() {},
  });
}

// `touch`: whether the device is touch-primary (hover: none, pointer: coarse).
async function fixture(t, innerWidth = 1280, { touch = innerWidth < 768 } = {}) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.window = Object.assign(new globalThis.EventTarget(), { innerWidth });
  const oldMatchMedia = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  globalThis.matchMedia = (query) => ({ matches: touch && query.includes('pointer: coarse') });
  globalThis.document = Object.assign(new globalThis.EventTarget(), {
    baseURI: 'http://localhost/',
    body: stubElement(),
    createElement: stubElement,
    getElementById: () => null,
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
  return player;
}

function holdForwardRight(player) {
  if (player.mobile) {
    player.mobileMoveX = 0.7;
    player.mobileMoveY = -0.7;
  } else {
    player.keys.add('KeyW');
    player.keys.add('KeyD');
  }
}

test('mobile controller follows movement without bending its path or changing pitch and zoom', async t => {
  const player = await fixture(t, 390);
  assert.equal(player.mobile, true);
  const pitch = player.cameraPitch;
  const distance = player.targetCameraDistance;
  holdForwardRight(player);
  player.update(1 / 60);
  const direction = player.horizontalVelocity.clone().normalize();
  for (let i = 0; i < 180; i++) player.update(1 / 60);
  assert.ok(player.cameraYaw < -0.5);
  assert.ok(direction.distanceTo(player.horizontalVelocity.clone().normalize()) < 1e-9);
  assert.equal(player.cameraPitch, pitch);
  assert.equal(player.targetCameraDistance, distance);
});

test('a narrow desktop window gets the touch layout but no auto-follow', async t => {
  const player = await fixture(t, 390, { touch: false });
  assert.equal(player.mobile, true);
  const yaw = player.cameraYaw;
  holdForwardRight(player);
  for (let i = 0; i < 180; i++) player.update(1 / 60);
  assert.equal(player.cameraYaw, yaw);
  assert.ok(player.horizontalVelocity.lengthSq() > 0);
});

test('desktop camera never auto-follows movement', async t => {
  const player = await fixture(t);
  assert.equal(player.mobile, false);
  const yaw = player.cameraYaw;
  holdForwardRight(player);
  for (let i = 0; i < 180; i++) player.update(1 / 60);
  assert.equal(player.cameraYaw, yaw);
  assert.ok(player.horizontalVelocity.lengthSq() > 0);
});

test('desktop manual look overrides follow and disabled controller preserves view', async t => {
  const player = await fixture(t);
  player.keys.add('KeyW');
  player.keys.add('KeyD');
  player.update(1 / 60);
  player.isLocked = true;
  document.dispatchEvent(Object.assign(new globalThis.Event('mousemove'), { movementX: 100, movementY: 20 }));
  const yaw = player.cameraYaw;
  for (let i = 0; i < 180; i++) player.update(1 / 60);
  assert.equal(player.cameraYaw, yaw);
  player.setEnabled(false);
  player.recenterCamera();
  player.update(1);
  assert.equal(player.cameraYaw, yaw);
  player.setEnabled(true);
  player.recenterCamera();
  player.update(1 / 60);
  assert.notEqual(player.cameraYaw, yaw);
});
