import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import * as waterGeometry from '../src/water/waterGeometry.js';
import { ReflectionBudget } from '../src/water/ReflectionBudget.js';

test('reflection visibility suspends capture and returning refreshes even without camera motion', () => {
  const budget = new ReflectionBudget();
  const camera = new THREE.PerspectiveCamera();
  assert.equal(budget.shouldRender(camera, 'ultra', 0, false), false);
  assert.equal(budget.shouldRender(camera, 'ultra', 1, true), true);
  assert.equal(budget.shouldRender(camera, 'ultra', 2, false), false);
  assert.equal(budget.shouldRender(camera, 'ultra', 3, true), true);
});

test('water chunks preserve every original triangle and attribute with local bounds', () => {
  const params = { size: 640, segments: 32, position: [100, -17, 0] };
  const river = { lakeLevel: -17, samples: Array.from({ length: 51 }, (_, i) => ({
    x: i * 20, z: -500, y: 100 - i * 2, dx: 1, dz: 0, s: i * 20, width: 10,
  })) };
  const original = waterGeometry.createWaterGeometry(params, river);
  assert.equal(typeof waterGeometry.partitionWaterGeometry, 'function');
  const chunks = waterGeometry.partitionWaterGeometry(original, 128);
  const triangles = geometry => {
    const result = [];
    for (let i = 0; i < geometry.index.count; i += 3) {
      const data = [];
      for (let j = 0; j < 3; j++) {
        const vertex = geometry.index.getX(i + j);
        for (const attribute of Object.values(geometry.attributes)) {
          for (let c = 0; c < attribute.itemSize; c++) data.push(attribute.array[vertex * attribute.itemSize + c]);
        }
      }
      result.push(JSON.stringify(data));
    }
    return result;
  };
  assert.ok(chunks.length > 10);
  assert.deepEqual(chunks.flatMap(triangles).sort(), triangles(original).sort());
  for (const chunk of chunks) {
    assert.ok(chunk.boundingBox.getSize(new THREE.Vector3()).x < 200);
    assert.ok(chunk.boundingBox.getSize(new THREE.Vector3()).z < 200);
    assert.ok(chunk.userData.waterLevelMin <= chunk.userData.waterLevelMax);
    chunk.dispose();
  }
  original.dispose();
});
