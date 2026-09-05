import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TerrainSampler } from '../src/world/TerrainSampler.js';

// Grass placement, tile visibility, interaction-map depth rejection and bird
// altitude all read through sampleHeight/worldToUv/contains, so a silent
// regression here is broad. These tests build the height grid by hand rather
// than loading a GLB.

const CONFIG = { terrain: { targetMeshName: 'None', sampleResolution: 3 } };

// A 3x3 grid over x,z in [0, 2], heights rising along +x.
//   z=2  0 1 2
//   z=1  0 1 2
//   z=0  0 1 2
function makeSampler() {
  const sampler = new TerrainSampler(null, CONFIG);
  sampler.resolution = 3;
  sampler.heights = new Float32Array([0, 1, 2, 0, 1, 2, 0, 1, 2]);
  sampler.bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 2, 2));
  sampler.size = sampler.bounds.getSize(new THREE.Vector3());
  sampler.ready = true;
  return sampler;
}

test('samples grid corners exactly', () => {
  const s = makeSampler();
  assert.equal(s.sampleHeight(0, 0), 0);
  assert.equal(s.sampleHeight(2, 0), 2);
  assert.equal(s.sampleHeight(0, 2), 0);
  assert.equal(s.sampleHeight(2, 2), 2);
});

test('interpolates bilinearly between grid points', () => {
  const s = makeSampler();
  assert.equal(s.sampleHeight(1, 1), 1);
  assert.equal(s.sampleHeight(0.5, 0), 0.5);
  assert.equal(s.sampleHeight(1.5, 1), 1.5);
});

test('returns minimum bound height outside the grid', () => {
  const s = makeSampler();
  assert.equal(s.sampleHeight(-1, 0), s.bounds.min.y);
  assert.equal(s.sampleHeight(3, 0), s.bounds.min.y);
  assert.equal(s.sampleHeight(0, -1), s.bounds.min.y);
  assert.equal(s.sampleHeight(0, 3), s.bounds.min.y);
});

test('returns 0 when not ready', () => {
  const s = makeSampler();
  s.ready = false;
  assert.equal(s.sampleHeight(1, 1), 0);
});

test('worldToUv maps bounds onto the unit square', () => {
  const s = makeSampler();
  assert.deepEqual(s.worldToUv(0, 0).toArray(), [0, 0]);
  assert.deepEqual(s.worldToUv(2, 2).toArray(), [1, 1]);
  assert.deepEqual(s.worldToUv(1, 1).toArray(), [0.5, 0.5]);
});

test('worldToUv clamps outside the bounds', () => {
  const s = makeSampler();
  assert.deepEqual(s.worldToUv(-5, -5).toArray(), [0, 0]);
  assert.deepEqual(s.worldToUv(50, 50).toArray(), [1, 1]);
});

test('worldToUv writes into a supplied target', () => {
  const s = makeSampler();
  const target = new THREE.Vector2();
  assert.equal(s.worldToUv(1, 1, target), target);
  assert.deepEqual(target.toArray(), [0.5, 0.5]);
});

test('contains respects bounds and padding', () => {
  const s = makeSampler();
  assert.ok(s.contains(1, 1));
  assert.ok(s.contains(0, 0));
  assert.ok(!s.contains(-0.01, 1));
  assert.ok(!s.contains(1, 2.01));

  // Positive padding shrinks the region.
  assert.ok(!s.contains(0, 0, 0.5));
  assert.ok(s.contains(1, 1, 0.5));

  // Negative padding grows it, as GrassField relies on for tile culling.
  assert.ok(s.contains(-0.5, 1, -1));
});
