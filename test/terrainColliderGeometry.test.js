import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createTerrainIndices, createWorldSpacePositions } from '../src/player/terrainColliderGeometry.js';

test('terrain collision vertices include parent transforms and scale', () => {
  const parent = new THREE.Group();
  parent.position.set(10, 2, -4);
  parent.rotation.y = Math.PI / 2;
  parent.scale.set(2, 3, 4);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ], 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.position.set(3, 1, 2);
  parent.add(mesh);
  parent.updateWorldMatrix(true, true);

  const actual = createWorldSpacePositions(mesh);
  const expected = [];
  const vertex = new THREE.Vector3();
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    vertex.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
    expected.push(vertex.x, vertex.y, vertex.z);
  }

  assert.deepEqual([...actual], expected);
});

test('terrain indices preserve authored indices and generate sequential fallback', () => {
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ], 3));
  indexed.setIndex([2, 1, 0]);
  assert.deepEqual([...createTerrainIndices(indexed)], [2, 1, 0]);

  const sequential = indexed.toNonIndexed();
  assert.deepEqual([...createTerrainIndices(sequential)], [0, 1, 2]);
});
