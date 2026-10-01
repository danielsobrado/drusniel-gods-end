import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { clampCameraAboveTerrain, constrainCameraLineOfSight, liftCameraOverTerrain } from '../src/player/cameraTerrain.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

const config = await loadMergedConfig();

function sampler({ height = 3, inside = true, sampleHeight } = {}) {
  return {
    contains: () => inside,
    sampleHeight: sampleHeight ?? (() => height),
  };
}

test('camera terrain clearance and occlusion are configured', () => {
  assert.ok(config.camera.controls.terrainClearance > 0);
  assert.ok(config.camera.controls.terrainOcclusionSamples >= 8);
  assert.ok(config.camera.controls.terrainOcclusionPadding > 0);
});

test('camera cannot move below terrain clearance', () => {
  const position = new THREE.Vector3(10, -50, 12);
  clampCameraAboveTerrain(position, sampler({ height: 3 }), 0.4);
  assert.equal(position.y, 3.4);
});

test('camera above the terrain is not moved', () => {
  const position = new THREE.Vector3(10, 8, 12);
  clampCameraAboveTerrain(position, sampler({ height: 3 }), 0.4);
  assert.equal(position.y, 8);
});

test('camera outside terrain bounds is not clamped to an edge sample', () => {
  const position = new THREE.Vector3(500, -2, 500);
  clampCameraAboveTerrain(position, sampler({ height: 20, inside: false }), 0.4);
  assert.equal(position.y, -2);
});

test('negative clearance is clamped to zero', () => {
  const position = new THREE.Vector3(0, 1, 0);
  clampCameraAboveTerrain(position, sampler({ height: 3 }), -10);
  assert.equal(position.y, 3);
});

test('camera line of sight pulls in before terrain blocks the player', () => {
  const target = new THREE.Vector3(0, 4, 0);
  const position = new THREE.Vector3(10, 4, 0);
  const terrain = sampler({
    sampleHeight: (x) => (x >= 4 && x <= 6 ? 8 : 0),
  });

  constrainCameraLineOfSight(position, target, terrain, {
    clearance: 0.4,
    samples: 20,
    padding: 0.3,
  });

  assert.ok(position.x < 4);
  assert.ok(position.x > 3);
});

test('camera line of sight keeps an unobstructed camera unchanged', () => {
  const target = new THREE.Vector3(0, 4, 0);
  const position = new THREE.Vector3(10, 6, 0);
  constrainCameraLineOfSight(position, target, sampler({ height: 0 }), {
    clearance: 0.4,
    samples: 20,
    padding: 0.3,
  });
  assert.deepEqual(position.toArray(), [10, 6, 0]);
});

// A 45-degree slope rising toward +z: ground height equals z.
const slope = { sampleHeight: (x, z) => z };

test('the camera rides up over a slope instead of being pulled into the character', () => {
  const target = new THREE.Vector3(0, 2, 0);
  const position = new THREE.Vector3(0, 2, 10);
  liftCameraOverTerrain(position, target, slope, { clearance: 0.5 });
  assert.ok(position.y >= 10.5, `camera clears the ground under it (${position.y})`);
  assert.equal(position.z, 10, 'the boom keeps its reach');
  const pulled = new THREE.Vector3(0, 2, 10);
  constrainCameraLineOfSight(pulled, target, slope, { clearance: 0.5 });
  assert.ok(pulled.distanceTo(target) < 3, 'the line-of-sight constraint alone pulls it in');
});

test('a camera lifted over a slope passes the line-of-sight check untouched', () => {
  // Lifting to exactly the clearance the line-of-sight check tests left the
  // result to floating-point noise: on some frames the check pulled the
  // camera in, on others not. Nudge the target like an idle character does.
  for (let i = 0; i < 200; i += 1) {
    const target = new THREE.Vector3(0.3, 2 + i * 1e-5, 0.7 + i * 1e-5);
    const position = new THREE.Vector3(0.1, 2, 10.3);
    const options = { clearance: 0.4, samples: 18, nearFraction: 0.2 };
    liftCameraOverTerrain(position, target, slope, options);
    const lifted = position.clone();
    constrainCameraLineOfSight(position, target, slope, options);
    assert.deepEqual(position.toArray(), lifted.toArray(), `nudge ${i}`);
  }
});

test('the terrain lift stops at the steepest allowed view', () => {
  const target = new THREE.Vector3(0, 0, 0);
  const position = new THREE.Vector3(0, 0, 10);
  const cliff = { sampleHeight: (x, z) => z * 5 };
  liftCameraOverTerrain(position, target, cliff, { maxElevationDegrees: 60 });
  assert.ok(Math.abs(position.y - 10 * Math.tan(Math.PI / 3)) < 1e-6);
});

test('line of sight ignores the footing next to the target when asked', () => {
  // A bump right beside the target, clear beyond it.
  const bump = { sampleHeight: (x, z) => (z < 1.5 ? 3 : 0) };
  const target = new THREE.Vector3(0, 2, 0);
  const near = new THREE.Vector3(0, 2, 10);
  constrainCameraLineOfSight(near, target, bump, { clearance: 0.4 });
  assert.ok(near.distanceTo(target) < 2, 'counting the footing collapses the boom');
  const far = new THREE.Vector3(0, 2, 10);
  constrainCameraLineOfSight(far, target, bump, { clearance: 0.4, nearFraction: 0.2 });
  assert.ok(far.distanceTo(target) > 9.9, 'skipping it keeps the boom');
});
