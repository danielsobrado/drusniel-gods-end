import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { clampCameraAboveTerrain } from '../src/player/cameraTerrain.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

const config = await loadMergedConfig();

function sampler({ height = 3, inside = true } = {}) {
  return {
    contains: () => inside,
    sampleHeight: () => height,
  };
}

test('camera terrain clearance is configured', () => {
  assert.ok(config.camera.controls.terrainClearance > 0);
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
