import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CoastalJungleCulling } from '../src/biome/CoastalJungleCulling.js';
import { cropCoastalJungleSurfaceIndex } from '../src/biome/CoastalJungleSurface.js';
import {
  coastalJungleKeepFraction,
  coastalJungleStableFraction,
  coastalJungleVisibilityLimit,
  isCoastalJungleTreeKind,
} from '../src/biome/CoastalJungleVisibility.js';

const render = {
  chunkSize: 16,
  grassDenseDistance: 14,
  grassDistance: 34,
  grassFarDensity: 0.2,
  groundcoverDistance: 28,
  undergrowthDistance: 72,
  treeDistance: 180,
  cameraMoveThreshold: 0.2,
  cameraRotationThreshold: 0.00002,
};
const quality = { maxDistance: 180, density: { grass: 0.9, shrub: 0.7 } };
const RADIUS = { grass: 0.5, groundcover: 0.6, shrub: 2, background_tree: 6 };

function record(kind, x, z) {
  const position = new THREE.Vector3(x, 0, z);
  return {
    kind,
    position,
    matrix: new Float32Array(new THREE.Matrix4().makeTranslation(x, 0, z).elements),
    sphere: new THREE.Sphere(position.clone(), RADIUS[kind]),
    stableFraction: coastalJungleStableFraction(position, kind),
  };
}

function batch(kind, records) {
  return {
    kind,
    parts: [{ count: -1, visible: false }, { count: -1, visible: false }],
    records,
    triangles: 10,
    attribute: new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, records.length) * 16), 16),
    writeCount: 0,
  };
}

function camera() {
  const view = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  view.position.set(3, 1.6, 7);
  view.lookAt(-4, 1.2, -60);
  view.updateMatrixWorld();
  return view;
}

test('coastal jungle culling draws exactly the records a per-record check keeps', () => {
  let seed = 17;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const batches = Object.keys(RADIUS).map((kind) => {
    const records = [];
    const count = kind === 'grass' ? 3000 : 500;
    for (let index = 0; index < count; index += 1) records.push(record(kind, random() * 240 - 120, random() * 240 - 150));
    return batch(kind, records);
  });
  const culling = new CoastalJungleCulling({ render }, batches, []);
  culling.build();
  const view = camera();
  const stats = culling.update(view, quality, true);

  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse),
  );
  let expectedTotal = 0;
  for (const current of batches) {
    const expected = current.records.filter((entry) => {
      const reach = coastalJungleVisibilityLimit(entry.kind, render, quality)
        + (isCoastalJungleTreeKind(entry.kind) ? entry.sphere.radius : 1);
      const distance = entry.position.distanceTo(view.position);
      return distance <= reach
        && entry.stableFraction <= coastalJungleKeepFraction(entry.kind, distance, render, quality)
        && frustum.intersectsSphere(entry.sphere);
    }).map((entry) => `${entry.matrix[12]},${entry.matrix[14]}`).sort();
    const written = [];
    for (let index = 0; index < current.writeCount; index += 1) {
      written.push(`${current.attribute.array[index * 16 + 12]},${current.attribute.array[index * 16 + 14]}`);
    }
    assert.deepEqual(written.sort(), expected, current.kind);
    assert.ok(expected.length > 0, `${current.kind} has visible records`);
    for (const part of current.parts) {
      assert.equal(part.count, current.writeCount);
      assert.equal(part.visible, current.writeCount > 0);
    }
    assert.equal(stats.byKind[current.kind], expected.length);
    expectedTotal += expected.length;
  }
  assert.equal(stats.visibleInstances, expectedTotal);
  assert.equal(stats.triangles, expectedTotal * 10);
});

test('coastal jungle culling shows authored singles and counts each plant once', () => {
  const near = record('background_tree', -2, -20);
  const parts = [true, false].map((primary) => ({
    object: { visible: false },
    kind: 'background_tree',
    primary,
    triangles: 5,
    record: near,
  }));
  const hidden = { object: { visible: true }, kind: 'background_tree', primary: true, triangles: 5, record: record('background_tree', 0, 60) };
  const culling = new CoastalJungleCulling({ render }, [], [...parts, hidden]);
  culling.build();
  const stats = culling.update(camera(), quality, true);
  assert.deepEqual(parts.map((part) => part.object.visible), [true, true]);
  assert.equal(hidden.object.visible, false);
  assert.equal(stats.byKind.background_tree, 1);
  assert.equal(stats.triangles, 10);
});

test('coastal jungle floor keeps only triangles the strip still shows', () => {
  const alpha = [0, 0, 0, 0, 0.5, 0, 1, 1, 1];
  assert.deepEqual(
    cropCoastalJungleSurfaceIndex([0, 1, 2, 3, 4, 5, 6, 7, 8], (vertex) => alpha[vertex]),
    [3, 4, 5, 6, 7, 8],
  );
});
