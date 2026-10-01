import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { InstancedLodSet } from '../src/world/InstancedLodSet.js';

function records(xs) {
  return xs.map((x, i) => {
    const position = new THREE.Vector3(x, 0, 0);
    return { position, phase: i / 10, matrix: new THREE.Matrix4().makeTranslation(x, 0, 0) };
  });
}

test('instances go to the level their distance calls for and past the last level to none', () => {
  const scene = new THREE.Scene();
  const set = new InstancedLodSet({
    scene, name: 'Test', material: new THREE.MeshBasicMaterial(), records: records([5, 15, 25, 45]),
    levels: [{ geometry: new THREE.BoxGeometry(), maxDistance: 10 }, { geometry: new THREE.BoxGeometry(), maxDistance: 30 }],
    attributes: { floraPhase: { itemSize: 1, read: (record, out) => { out[0] = record.phase; } } },
  });
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 0);
  set.update(camera);
  assert.deepEqual(set.meshes.map(mesh => mesh.count), [1, 2]);
  // Per-instance values follow their instance into its level's buffer.
  assert.ok(Math.abs(set.meshes[1].geometry.attributes.floraPhase.array[1] - 0.2) < 1e-6);
  const matrix = new THREE.Matrix4();
  set.meshes[1].getMatrixAt(0, matrix);
  assert.equal(new THREE.Vector3().setFromMatrixPosition(matrix).x, 15);
});

test('small camera moves do not re-bucket, and far cameras clear every level', () => {
  const scene = new THREE.Scene();
  const set = new InstancedLodSet({
    scene, name: 'Test', material: new THREE.MeshBasicMaterial(), records: records([5]), rebucketDistance: 6,
    levels: [{ geometry: new THREE.BoxGeometry(), maxDistance: 10 }],
  });
  const camera = new THREE.PerspectiveCamera();
  set.update(camera);
  assert.equal(set.meshes[0].count, 1);
  camera.position.set(3, 0, 0);
  set.meshes[0].count = 99;
  set.update(camera);
  assert.equal(set.meshes[0].count, 99, 'under the re-bucket distance nothing is rewritten');
  camera.position.set(500, 0, 0);
  set.update(camera);
  assert.equal(set.meshes[0].count, 0);
  set.dispose();
  assert.equal(scene.children.length, 0);
});
