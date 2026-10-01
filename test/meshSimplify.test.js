import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { meshSimplifierReady, simplifiedStage } from '../src/rendering/meshSimplify.js';

test('a simplified stage shares the source vertices and only replaces the index', async () => {
  await meshSimplifierReady;
  const source = new THREE.SphereGeometry(1, 64, 32);
  source.computeBoundingSphere();
  const stage = simplifiedStage(source, { ratio: 0.1 });
  assert.notEqual(stage, source);
  assert.ok(stage.index.count <= source.index.count * 0.1 + 3, 'ratio bounds the triangle count');
  for (const name of Object.keys(source.attributes)) {
    assert.equal(stage.attributes[name], source.attributes[name], `${name} is shared, not copied`);
  }
  assert.ok(stage.boundingSphere.radius > 0.99);
  stage.dispose(); source.dispose();
});

test('an error bound stops simplification before the ratio does', async () => {
  await meshSimplifierReady;
  const source = new THREE.SphereGeometry(1, 64, 32);
  const tight = simplifiedStage(source, { error: 0.0005 });
  const loose = simplifiedStage(source, { error: 0.01 });
  assert.ok(tight.index.count > loose.index.count);
  tight.dispose(); loose.dispose(); source.dispose();
});

test('geometry that cannot be simplified safely is returned unchanged', async () => {
  await meshSimplifierReady;
  const grouped = new THREE.BoxGeometry(1, 1, 1, 8, 8, 8);
  assert.equal(simplifiedStage(grouped, { ratio: 0.1 }), grouped, 'material groups would be scrambled');
  const unindexed = new THREE.SphereGeometry(1, 16, 8).toNonIndexed();
  assert.equal(simplifiedStage(unindexed, { ratio: 0.1 }), unindexed);
  grouped.dispose(); unindexed.dispose();
});
