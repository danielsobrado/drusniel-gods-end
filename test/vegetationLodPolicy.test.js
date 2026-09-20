import test from 'node:test';
import assert from 'node:assert/strict';
import { treeLodCenters, vegetationLodWeights } from '../src/foliage/vegetationLodPolicy.js';
test('all four tree levels overlap without gaps and reverse immediately', () => {
  const settings = { centers: treeLodCenters(12), far: 4000 };
  for (const distances of [[0, 80, 160, 300, 500], [500, 300, 160, 80, 0]]) {
    for (const distance of distances) {
      const w = vegetationLodWeights(distance, settings);
      assert.ok(Math.abs(w.reduce((a, b) => a + b) - 1) < 1e-10);
      assert.ok(w.every(v => v >= 0 && v <= 1));
    }
  }
  assert.deepEqual(vegetationLodWeights(0, settings), [1, 0, 0, 0]);
  assert.deepEqual(vegetationLodWeights(4001, settings), [0, 0, 0, 0]);
  assert.equal(vegetationLodWeights(3900, settings)[3] > 0, true);
});

test('configured height cap keeps large tree geometry within the previous draw budget', () => {
  const settings = { distances: [35, 75, 135], referenceHeight: 12, maxHeightScale: 1.1 };
  const centers = treeLodCenters(60, 'high', settings);
  assert.ok(centers[2] * 1.15 < 171);
  assert.deepEqual(vegetationLodWeights(171, { centers, far: 4000 }), [0, 0, 0, 1]);
  assert.ok(treeLodCenters(6, 'high', settings)[0] < centers[0]);
});
test('missing assets retain a valid representation and tree scale and quality affect detail', () => {
  const centers = treeLodCenters(12);
  assert.deepEqual(vegetationLodWeights(240, { centers, far: 4000, available: [true, false, false, true] }), [1, 0, 0, 0]);
  assert.deepEqual(vegetationLodWeights(500, { centers, far: 4000, available: [true, true, true, false] }), [0, 0, 1, 0]);
  assert.deepEqual(treeLodCenters(24), centers.map(v => v * 2));
  assert.ok(treeLodCenters(12, 'performance')[0] < centers[0]);
});
