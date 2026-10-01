import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  projectedTreeHeightPixels,
  treeLodCenters,
  treeLodScreenHeights,
  vegetationLodScreenWeights,
  vegetationLodWeights,
} from '../src/foliage/vegetationLodPolicy.js';
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
test('a shorter center list hands the range to the impostor rather than to a mesh stage', () => {
  const settings = { centers: treeLodCenters(12, 'high', { distances: [35, 75], referenceHeight: 12 }), far: 4000 };
  assert.deepEqual(settings.centers, [35, 75]);
  for (const distance of [0, 35, 75, 200, 3000]) {
    const w = vegetationLodWeights(distance, settings);
    assert.ok(Math.abs(w.reduce((a, b) => a + b) - 1) < 1e-10, `coverage at ${distance}`);
    assert.equal(w[2], 0, `no decimated stage at ${distance}`);
  }
  assert.deepEqual(vegetationLodWeights(0, settings), [1, 0, 0, 0]);
  assert.deepEqual(vegetationLodWeights(90, settings), [0, 0, 0, 1]);
  assert.ok(vegetationLodWeights(75, settings)[1] > 0 && vegetationLodWeights(75, settings)[3] > 0);
});
test('missing assets retain a valid representation and tree scale and quality affect detail', () => {
  const centers = treeLodCenters(12);
  assert.deepEqual(vegetationLodWeights(240, { centers, far: 4000, available: [true, false, false, true] }), [1, 0, 0, 0]);
  assert.deepEqual(vegetationLodWeights(500, { centers, far: 4000, available: [true, true, true, false] }), [0, 0, 1, 0]);
  assert.deepEqual(treeLodCenters(24), centers.map(v => v * 2));
  assert.ok(treeLodCenters(12, 'performance')[0] < centers[0]);
});

test('screen-space tree LOD responds to projected size and quality', () => {
  const settings = {
    screenSpace: { enabled: true, heights: [260, 125, 80] },
  };
  assert.deepEqual(treeLodScreenHeights('high', settings), [260, 125, 80]);
  assert.ok(treeLodScreenHeights('performance', settings)[0] > 260);
  assert.ok(treeLodScreenHeights('ultra', settings)[0] < 260);

  const projected = projectedTreeHeightPixels(12, 100, 1 / Math.tan(THREE.MathUtils.degToRad(70 / 2)), 1080);
  assert.ok(projected > 90 && projected < 95);
  const low = vegetationLodScreenWeights(projected, 100, {
    screenHeights: treeLodScreenHeights('high', settings),
    far: 1000,
  });
  assert.equal(low[2], 1);
});

test('screen-space LOD keeps more detail when zoomed and less on a shorter viewport', () => {
  const settings = { screenSpace: { enabled: true, heights: [260, 125, 80] } };
  const screenHeights = treeLodScreenHeights('high', settings);
  const projection70 = 1 / Math.tan((70 * Math.PI / 180) / 2);
  const projection35 = 1 / Math.tan((35 * Math.PI / 180) / 2);
  const normal = projectedTreeHeightPixels(12, 100, projection70, 1080);
  const zoomed = projectedTreeHeightPixels(12, 100, projection35, 1080);
  const shortViewport = projectedTreeHeightPixels(12, 100, projection70, 540);
  assert.equal(vegetationLodScreenWeights(normal, 100, { screenHeights, far: 1000 })[2], 1);
  assert.equal(vegetationLodScreenWeights(zoomed, 100, { screenHeights, far: 1000 })[1], 1);
  assert.equal(vegetationLodScreenWeights(shortViewport, 100, { screenHeights, far: 1000 })[3], 1);
});
