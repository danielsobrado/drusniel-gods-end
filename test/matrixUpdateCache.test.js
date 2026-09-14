import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { installMatrixUpdateCache } from '../src/core/matrixUpdateCache.js';
import { createRandom } from '../src/utils/random.js';

installMatrixUpdateCache();

function countComposes(object) {
  let count = 0;
  const original = object.matrix.compose.bind(object.matrix);
  object.matrix.compose = (...args) => {
    count += 1;
    return original(...args);
  };
  return () => count;
}

test('installs once', () => {
  assert.equal(installMatrixUpdateCache(), false);
});

test('static objects are composed once and keep their world matrix', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh();
  mesh.position.set(1, 2, 3);
  scene.add(mesh);
  const composes = countComposes(mesh);
  for (let pass = 0; pass < 5; pass += 1) scene.updateMatrixWorld();
  assert.equal(composes(), 1);
  assert.deepEqual([...mesh.matrixWorld.elements.slice(12, 15)], [1, 2, 3]);
});

test('moved parents update their descendants', () => {
  const scene = new THREE.Scene();
  const parent = new THREE.Object3D();
  const child = new THREE.Object3D();
  child.position.set(0, 0, 5);
  parent.add(child);
  scene.add(parent);
  scene.updateMatrixWorld();

  parent.position.x = 10;
  scene.updateMatrixWorld();
  assert.equal(child.matrixWorld.elements[12], 10);

  parent.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  scene.updateMatrixWorld();
  assert.ok(Math.abs(child.matrixWorld.elements[12] - 15) < 1e-9);

  parent.scale.setScalar(2);
  scene.updateMatrixWorld();
  assert.ok(Math.abs(child.matrixWorld.elements[12] - 20) < 1e-9);
});

test('re-parenting refreshes the world matrix without a local change', () => {
  const scene = new THREE.Scene();
  const first = new THREE.Object3D();
  first.position.x = 1;
  const second = new THREE.Object3D();
  second.position.x = 100;
  const child = new THREE.Object3D();
  scene.add(first, second);
  first.add(child);
  scene.updateMatrixWorld();
  assert.equal(child.matrixWorld.elements[12], 1);

  second.add(child);
  scene.updateMatrixWorld();
  assert.equal(child.matrixWorld.elements[12], 100);

  first.attach(child);
  scene.updateMatrixWorld();
  assert.equal(child.matrixWorld.elements[12], 100);
});

test('random walk stays bit-identical to explicit composition', () => {
  const random = createRandom(20260914);
  const scene = new THREE.Scene();
  const nodes = [];
  for (let index = 0; index < 60; index += 1) {
    const node = new THREE.Object3D();
    const parent = index === 0 || random() < 0.3 ? scene : nodes[Math.floor(random() * nodes.length)];
    parent.add(node);
    nodes.push(node);
  }
  const expected = new Map();
  const local = new THREE.Matrix4();
  const expectedWorld = (node) => {
    local.compose(node.position, node.quaternion, node.scale);
    const parentWorld = node.parent === scene ? scene.matrixWorld : expected.get(node.parent);
    return new THREE.Matrix4().multiplyMatrices(parentWorld, local);
  };

  for (let frame = 0; frame < 200; frame += 1) {
    for (const node of nodes) {
      if (random() < 0.1) node.position.set(random() * 10, random() * 10, random() * 10);
      if (random() < 0.05) node.quaternion.setFromEuler(new THREE.Euler(random(), random(), random()));
      if (random() < 0.03) node.scale.setScalar(0.5 + random());
    }
    scene.updateMatrixWorld();
    expected.clear();
    for (const node of nodes) {
      const world = expectedWorld(node);
      expected.set(node, world);
      assert.deepEqual([...node.matrixWorld.elements], [...world.elements], `frame ${frame}`);
    }
  }
});
