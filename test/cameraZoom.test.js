import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

// Wheel zoom drives a target distance that the camera damps toward, using
// camera.minDistance / maxDistance and controls.zoomSensitivity -- four keys
// that existed in configuration long before anything read them.
//
// PlayerController cannot be constructed under Node (it pulls in GLTF loaders
// and DOM), so these tests pin the two pieces of logic that matter and would
// otherwise only be checked by hand: the clamp, and the damping convergence.

const config = await loadMergedConfig();

function applyZoomDelta(current, deltaY, cfg = config) {
  const sensitivity = cfg.camera.controls.zoomSensitivity ?? 0.01;
  const min = cfg.camera.minDistance ?? 1.5;
  const max = cfg.camera.maxDistance ?? 24;
  return THREE.MathUtils.clamp(current + deltaY * sensitivity, min, max);
}

test('configuration exposes the keys the zoom reads', () => {
  assert.equal(typeof config.camera.controls.zoomSensitivity, 'number');
  assert.equal(typeof config.camera.controls.zoomSharpness, 'number');
  assert.equal(typeof config.camera.minDistance, 'number');
  assert.equal(typeof config.camera.maxDistance, 'number');
  assert.ok(config.camera.minDistance < config.camera.maxDistance);
});

test('scrolling down pushes the camera out, up pulls it in', () => {
  const start = config.camera.controls.desktopDistance;
  assert.ok(applyZoomDelta(start, 100) > start, 'positive deltaY zooms out');
  assert.ok(applyZoomDelta(start, -100) < start, 'negative deltaY zooms in');
});

test('zoom clamps to the configured bounds', () => {
  assert.equal(applyZoomDelta(config.camera.maxDistance, 100000), config.camera.maxDistance);
  assert.equal(applyZoomDelta(config.camera.minDistance, -100000), config.camera.minDistance);
});

test('repeated scrolling never escapes the bounds', () => {
  let distance = config.camera.controls.desktopDistance;
  for (let i = 0; i < 500; i += 1) {
    distance = applyZoomDelta(distance, i % 2 === 0 ? 240 : -180);
    assert.ok(distance >= config.camera.minDistance, `below min: ${distance}`);
    assert.ok(distance <= config.camera.maxDistance, `above max: ${distance}`);
  }
});

test('damping converges on the target and does not overshoot', () => {
  const sharpness = config.camera.controls.zoomSharpness;
  const target = 12;
  let distance = 5;
  let previous = distance;

  for (let frame = 0; frame < 240; frame += 1) {
    const factor = 1 - Math.exp(-sharpness * (1 / 60));
    distance += (target - distance) * factor;
    assert.ok(distance <= target + 1e-9, `overshot target: ${distance}`);
    assert.ok(distance >= previous - 1e-9, 'must move monotonically toward the target');
    previous = distance;
  }

  assert.ok(Math.abs(distance - target) < 1e-6, `did not converge: ${distance}`);
});

test('a zero-delta wheel event leaves the distance unchanged', () => {
  const start = config.camera.controls.desktopDistance;
  assert.equal(applyZoomDelta(start, 0), start);
});
