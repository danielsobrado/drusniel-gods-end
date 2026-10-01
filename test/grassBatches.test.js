import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { GrassBatches } from '../src/grass/GrassBatches.js';

const STRIDE = 4;

function template() {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 1, 0, 0], 3));
  geometry.setAttribute('instancePosition', new StorageInstancedBufferAttribute(new Float32Array(STRIDE * 3), 3));
  return geometry;
}

function tile(x, z, count, marker) {
  const geometry = new THREE.InstancedBufferGeometry();
  const positions = new Float32Array(STRIDE * 4);
  for (let i = 0; i < count; i++) positions.set([marker + i, 0, marker, 0], i * 4);
  geometry.setAttribute('instancePosition', new StorageInstancedBufferAttribute(positions, 4));
  geometry.setAttribute('instanceRotation', new StorageInstancedBufferAttribute(new Float32Array(STRIDE * 2), 2));
  geometry.setAttribute('instanceData', new StorageInstancedBufferAttribute(new Float32Array(STRIDE * 4), 4));
  geometry.instanceCount = count;
  const mesh = new THREE.Mesh(geometry);
  mesh.position.set(x, 0, z);
  return { mesh };
}

function frame(batches, tiles) {
  batches.begin();
  for (const member of tiles) batches.add('low', member);
  batches.commit(null);
  return batches.batches.get('low');
}

test('grass batches give each tile a fixed slot and upload only changed slots', () => {
  const scene = new THREE.Scene();
  const batches = new GrassBatches(scene);
  batches.setTemplates({ low: template() }, null, { low: 16 });
  const a = tile(25, 50, 3, 100), b = tile(-25, 0, 2, 200);

  let batch = frame(batches, [a, b]);
  const positions = () => batch.geometry.attributes.instancePosition.array;
  assert.equal(batch.geometry.instanceCount, 2 * STRIDE);
  assert.equal(batch.mesh.visible, true);
  assert.deepEqual([...positions().subarray(0, 4)], [100, 0, 100, 0]);
  assert.equal(positions()[3 * 4], 1e7, 'unused instances in a slot sit out of range');
  assert.deepEqual([...batch.geometry.attributes.instanceTile.array.subarray(STRIDE * 2, STRIDE * 2 + 2)], [-25, 0]);

  const version = batch.geometry.attributes.instancePosition.version;
  batch = frame(batches, [a, b]);
  assert.equal(batch.geometry.attributes.instancePosition.version, version, 'an unchanged frame uploads nothing');

  // `a` leaves: its slot empties, `b` keeps slot 1 and only slot 0 uploads.
  batch = frame(batches, [b]);
  assert.equal(positions()[0], 1e7);
  assert.equal(positions()[STRIDE * 4], 200, 'b keeps its slot');
  assert.deepEqual(batch.geometry.attributes.instancePosition.updateRanges, [{ start: 0, count: STRIDE * 4 }]);

  // A new tile reuses the freed slot; dropping the last slot shortens the draw.
  const c = tile(0, 25, 1, 300);
  batch = frame(batches, [b, c]);
  assert.equal(positions()[0], 300);
  batch = frame(batches, [c]);
  assert.equal(batch.geometry.instanceCount, STRIDE);

  batch = frame(batches, []);
  assert.equal(batch.mesh.visible, false);
  batches.dispose();
});
