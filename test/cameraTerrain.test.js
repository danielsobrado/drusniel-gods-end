import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { clampCameraAboveTerrain, constrainCameraLineOfSight } from '../src/player/cameraTerrain.js';
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
