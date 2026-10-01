import assert from 'node:assert/strict';
import test from 'node:test';
import { CameraFollow } from '../src/player/CameraFollow.js';

function step(follow, overrides = {}) {
  return follow.update({ yaw: 0, x: 0.5, z: -1, dt: 1 / 60, touch: true, ...overrides });
}

test('sustained forward diagonal movement aligns smoothly without changing steering basis', () => {
  const follow = new CameraFollow();
  let yaw = 0;
  for (let i = 0; i < 180; i++) {
    const state = step(follow, { yaw });
    assert.equal(state.movementYaw, 0);
    yaw = state.yaw;
  }
  assert.ok(Math.abs(yaw + Math.atan(0.5)) < 0.01);
});

test('manual look persists during movement and idle, then rearms on a fresh gesture', () => {
  const follow = new CameraFollow();
  step(follow);
  follow.manualLook(0.7);
  for (let i = 0; i < 180; i++) assert.equal(step(follow, { yaw: 0.7 }).yaw, 0.7);
  for (let i = 0; i < 60; i++) assert.equal(step(follow, { yaw: 0.7, x: 0, z: 0 }).yaw, 0.7);
  let yaw = 0.7;
  for (let i = 0; i < 60; i++) yaw = step(follow, { yaw }).yaw;
  assert.ok(yaw < 0.6);
});

test('short pauses and backward or sideways movement do not swing the camera', () => {
  const follow = new CameraFollow();
  follow.manualLook(1);
  step(follow, { yaw: 1, x: 0, z: 0, dt: 0.2 });
  assert.equal(step(follow, { yaw: 1 }).yaw, 1);
  for (const [x, z] of [[1, 0], [0, 1], [0.01, -0.01]]) {
    const fresh = new CameraFollow();
    for (let i = 0; i < 120; i++) assert.equal(step(fresh, { x, z }).yaw, 0);
  }
});

test('recenter clears override, uses shortest arc, and keeps a stable movement basis', () => {
  const follow = new CameraFollow();
  follow.manualLook(3.1);
  follow.recenter(-3.1);
  const state = step(follow, { yaw: 3.1, x: 0, z: 0 });
  assert.ok(state.yaw > 3.1 && state.yaw < 3.184);
});

test('auto-follow only runs on touch devices and its damping is frame rate independent', () => {
  function simulate(dt, touch) {
    const follow = new CameraFollow();
    let yaw = 0;
    for (let elapsed = 0; elapsed < 1 - dt / 2; elapsed += dt) yaw = step(follow, { yaw, dt, touch }).yaw;
    return yaw;
  }
  assert.ok(Math.abs(simulate(1 / 60, true)) > 0.1);
  assert.equal(simulate(1 / 60, false), 0);
  assert.ok(Math.abs(simulate(1 / 60, true) - simulate(1 / 120, true)) < 0.01);
});

test('desktop still honours an explicit recenter request', () => {
  const follow = new CameraFollow();
  follow.recenter(1);
  let yaw = 0;
  for (let i = 0; i < 600; i++) yaw = step(follow, { yaw, x: 0, z: 0, touch: false }).yaw;
  assert.ok(Math.abs(yaw - 1) < 0.01);
});

test('holding a look touch prevents auto-follow and reset starts a fresh steering basis', () => {
  const follow = new CameraFollow();
  for (let i = 0; i < 120; i++) assert.equal(step(follow, { looking: true }).yaw, 0);
  follow.resetGesture();
  assert.equal(step(follow, { yaw: 1 }).movementYaw, 1);
});
