import assert from 'node:assert/strict';
import test from 'node:test';
import { installEmptyDrawSkip, isEmptyInstancedDraw } from '../src/rendering/skipEmptyDraws.js';
import {
  adoptInstanceMatrices,
  createInstanceMatrixAttribute,
  setStorageInstanceMatrices,
} from '../src/rendering/instanceMatrices.js';

test('empty instanced draws are recognised, everything else is drawn', () => {
  assert.equal(isEmptyInstancedDraw({ isInstancedMesh: true, count: 0 }, {}), true);
  assert.equal(isEmptyInstancedDraw({ isInstancedMesh: true, count: 3 }, {}), false);
  assert.equal(isEmptyInstancedDraw({ isMesh: true }, { isInstancedBufferGeometry: true, instanceCount: 0 }), true);
  assert.equal(isEmptyInstancedDraw({ isMesh: true }, { isInstancedBufferGeometry: true, instanceCount: Infinity }), false);
  assert.equal(isEmptyInstancedDraw({ isMesh: true }, {}), false);
});

test('the renderer hook skips empty draws, passes the rest through and restores', () => {
  const calls = [];
  const renderer = { renderObject(object) { calls.push(object.id); return object.id; } };
  const original = renderer.renderObject;
  const restore = installEmptyDrawSkip(renderer);
  assert.equal(renderer.renderObject({ id: 1, isInstancedMesh: true, count: 0 }, null, null, {}), undefined);
  assert.equal(renderer.renderObject({ id: 2, isInstancedMesh: true, count: 5 }, null, null, {}), 2);
  assert.deepEqual(calls, [2]);
  // Installing twice must not stack wrappers.
  installEmptyDrawSkip(renderer)();
  restore();
  assert.equal(renderer.renderObject, original);
});

test('instance matrices use versioned storage only on WebGPU', () => {
  try {
    setStorageInstanceMatrices(false);
    const plain = createInstanceMatrixAttribute(4);
    assert.equal(plain.isStorageInstancedBufferAttribute, undefined);
    assert.equal(plain.array.length, 64);

    setStorageInstanceMatrices(true);
    const storage = createInstanceMatrixAttribute(0);
    assert.equal(storage.isStorageInstancedBufferAttribute, true);
    assert.equal(storage.itemSize, 16);
    assert.equal(storage.array.length, 16);

    const array = new Float32Array(32).fill(1);
    const mesh = { instanceMatrix: { array, usage: 35048 } };
    adoptInstanceMatrices(mesh);
    assert.equal(mesh.instanceMatrix.isStorageInstancedBufferAttribute, true);
    assert.equal(mesh.instanceMatrix.array, array);
    assert.equal(mesh.instanceMatrix.usage, 35048);
  } finally {
    setStorageInstanceMatrices(false);
  }
});
