import assert from 'node:assert/strict';
import test from 'node:test';
import { UnderstoryLod } from '../src/foliage/understoryLod.js';
import { resolveUnderstorySettings } from '../src/foliage/understoryPlacement.js';

test('understory keeps detailed geometry nearby, overlaps the transition and replaces distant meshes', () => {
  const lod = new UnderstoryLod(5);
  const origins = new Float32Array([0, 0, 5, 0, 0, 19, 0, 0, 25, 0, 0, 33, 0, 0, 50]);
  lod.partition(origins, 5, { x: 0, z: 0 }, 22, 30);
  assert.deepEqual([...lod.near.slice(0, lod.nearCount)], [0, 1, 2]);
  assert.deepEqual([...lod.far.slice(0, lod.farCount)], [2, 3, 4]);
  assert.equal(new Set([...lod.near.slice(0, lod.nearCount), ...lod.far.slice(0, lod.farCount)]).size, 5);
  lod.partition(origins, 5, { x: 0, z: 50 }, 22, 30);
  assert.deepEqual([...lod.near.slice(0, lod.nearCount)], [1, 2, 3, 4]);
  assert.deepEqual([...lod.far.slice(0, lod.farCount)], [0, 1, 2]);
});

test('LOD partition never drops a plant as the camera crosses either transition boundary', () => {
  const lod = new UnderstoryLod(1), origins = new Float32Array([0, 1, 0]);
  for (let z = 0; z <= 60; z += 0.1) {
    lod.partition(origins, 1, { x: 0, z }, 22, 30);
    assert.ok(lod.nearCount + lod.farCount >= 1);
    if (z > 30 && z < 32) assert.equal(lod.nearCount, 1, 'padding covers movement between updates');
  }
});

test('lower quality uses billboards sooner and valid transition widths survive config overrides', () => {
  const ranges = ['performance', 'balanced', 'high', 'ultra'].map(quality => resolveUnderstorySettings({}, 'sunny', quality));
  for (let i = 0; i < ranges.length; i++) {
    assert.ok(ranges[i].billboardStart < ranges[i].billboardEnd);
    if (i) assert.ok(ranges[i].billboardStart > ranges[i - 1].billboardStart);
  }
  const settings = resolveUnderstorySettings({ foliage: { understory: { billboardStart: 30, billboardEnd: 10 } } }, 'sunny', 'high');
  assert.ok(settings.billboardEnd > settings.billboardStart);
});
