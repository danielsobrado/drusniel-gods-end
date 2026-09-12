import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCoastalGroundcover, disposeCoastalGroundcover } from '../src/world/CoastalGroundcover.js';

test('every creeping leaf is grounded at its own position on a sloping beach', () => {
  const terrain = {
    bounds: { min: { x: 600, z: -200 }, max: { x: 1200, z: 200 } },
    sampleHeight: (x, z) => x * 0.2 + z * 0.05,
  };
  const group = createCoastalGroundcover(terrain, {
    enabled: true, level: -24, shoreX: 1000,
    coast: { vegetation: { maxPatches: 30 } },
  }, 'ultra');
  try {
    const mesh = group.children[0];
    assert.ok(mesh.count > 20, 'fixture must place enough leaves to exercise clump offsets');
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
    for (let i = 0; i < mesh.count; i += 1) {
      mesh.getMatrixAt(i, matrix);
      position.setFromMatrixPosition(matrix);
      assert.ok(Math.abs(position.y - terrain.sampleHeight(position.x, position.z) - 0.025) < 0.0001,
        `leaf ${i} floats or sinks after horizontal clump offset`);
    }
    const points = mesh.geometry.attributes.position;
    const indices = mesh.geometry.index.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < indices.length; i += 3) {
      a.fromBufferAttribute(points, indices[i]);
      b.fromBufferAttribute(points, indices[i + 1]);
      c.fromBufferAttribute(points, indices[i + 2]);
      assert.ok(b.sub(a).cross(c.sub(a)).lengthSq() > 0, 'leaf triangles must not be degenerate');
    }
  } finally {
    disposeCoastalGroundcover(group);
  }
});

test('groundcover placement and surface tuning come from the resolved coast configuration', () => {
  const group = createCoastalGroundcover({
    bounds: { min: { x: 600, z: -200 }, max: { x: 1200, z: 200 } },
    sampleHeight: () => 3,
  }, {
    enabled: true,
    coast: { vegetation: { maxPatches: 3, minClumps: 2, maxClumps: 2,
      clusterRadius: 0, groundOffset: 0.07, roughness: 0.43 } },
  }, 'ultra');
  try {
    const mesh = group.children[0], matrix = new THREE.Matrix4();
    assert.equal(mesh.material.roughness, 0.43);
    assert.equal(mesh.count, 6);
    for (let i = 0; i < mesh.count; i += 2) {
      mesh.getMatrixAt(i, matrix);
      const first = new THREE.Vector3().setFromMatrixPosition(matrix);
      mesh.getMatrixAt(i + 1, matrix);
      const second = new THREE.Vector3().setFromMatrixPosition(matrix);
      assert.ok(Math.abs(first.y - 3.07) < 0.00001);
      assert.deepEqual(first.toArray(), second.toArray(), 'zero cluster radius keeps both clumps at the patch anchor');
    }
  } finally {
    disposeCoastalGroundcover(group);
  }
});
