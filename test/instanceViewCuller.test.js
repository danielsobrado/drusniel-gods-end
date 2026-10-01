import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix4, PerspectiveCamera, Quaternion, Sphere, Vector3 } from 'three';
import {
  InstanceSelectionMemo,
  InstanceSphereCache,
  InstanceViewCuller,
  IncrementalViewCull,
  ViewCullBudget,
  copySelectedInstances,
  resolveInstanceViewCullingSettings,
} from '../src/foliage/InstanceViewCuller.js';
import { UnderstoryLod } from '../src/foliage/understoryLod.js';

function instanceMatrices(points) {
  const values = new Float32Array(points.length * 16);
  const matrix = new Matrix4();
  points.forEach(([x, y, z], index) => {
    matrix.makeTranslation(x, y, z).toArray(values, index * 16);
  });
  return values;
}

test('instance view culler rejects instances outside the camera envelope', () => {
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.lookAt(0, 0, -1);
  camera.updateProjectionMatrix();

  const culler = new InstanceViewCuller(camera, {
    cameraMoveThreshold: 0,
    cameraRotationThreshold: 0,
    turnMarginDegrees: 0,
    boundsScale: 1,
    boundsPadding: 0,
  });
  culler.update(true);

  const matrices = instanceMatrices([[0, 0, -10], [0, 0, 10], [50, 0, -10]]);
  const visible = new Uint32Array(3);
  const localSphere = new Sphere(new Vector3(), 0.5);
  const count = culler.collectVisible(matrices, 3, localSphere, visible);
  assert.deepEqual([...visible.subarray(0, count)], [0]);

  camera.lookAt(0, 0, 1);
  culler.update(true);
  const reversed = culler.collectVisible(matrices, 3, localSphere, visible);
  assert.deepEqual([...visible.subarray(0, reversed)], [1]);
});

test('instance view culling settings remain conservative', () => {
  const defaults = resolveInstanceViewCullingSettings();
  assert.equal(defaults.enabled, true);
  assert.ok(defaults.turnMarginDegrees > 0);
  assert.ok(defaults.boundsScale >= 1);
  assert.ok(defaults.boundsPadding >= 0);

  const configured = resolveInstanceViewCullingSettings({
    enabled: false,
    boundsScale: 0.2,
    boundsPadding: -1,
  });
  assert.equal(configured.enabled, false);
  assert.equal(configured.boundsScale, 1);
  assert.equal(configured.boundsPadding, 0);
});

test('selected instance attributes compact without temporary source buffers', () => {
  const source = new Float32Array([10, 11, 20, 21, 30, 31, 40, 41]);
  const target = new Float32Array(source.length);
  copySelectedInstances(source, target, 2, new Uint32Array([3, 1]), 2);
  assert.deepEqual([...target.subarray(0, 4)], [40, 41, 20, 21]);
});

test('a shared view-cull budget spreads one repack across frames', () => {
  let clock = 0;
  const budget = new ViewCullBudget({ budgetMs: 10, now: () => clock });
  const cull = new IncrementalViewCull(budget);
  const units = [1, 2, 3, 4, 5];
  const applied = [];
  const apply = (unit) => { applied.push(unit); clock += 6; };

  assert.equal(cull.request(), true);
  budget.begin();
  assert.equal(cull.step(units, apply), false, 'two units exhaust the budget');
  assert.deepEqual(applied, [1, 2]);
  assert.equal(cull.pending, true);

  budget.begin();
  assert.equal(cull.step(units, apply), false);
  assert.deepEqual(applied, [1, 2, 3, 4]);

  budget.begin();
  assert.equal(cull.step(units, apply), true, 'the final frame completes the pass');
  assert.deepEqual(applied, [1, 2, 3, 4, 5]);
  assert.equal(cull.pending, false);
});

test('a view-cull without a budget still completes in a single step', () => {
  const cull = new IncrementalViewCull(null);
  const applied = [];
  cull.request();
  assert.equal(cull.step([1, 2, 3], (unit) => applied.push(unit)), true);
  assert.deepEqual(applied, [1, 2, 3]);
});

test('a cull requested mid-pass repeats as a distinct pass', () => {
  const budget = new ViewCullBudget({ budgetMs: 0, now: () => 0 });
  const cull = new IncrementalViewCull(budget);
  let starts = 0;
  const step = () => cull.step([1, 2], () => {}, () => { starts += 1; });
  budget.begin();
  cull.request();
  assert.equal(step(), false, 'zero budget yields one unit per step');
  assert.equal(cull.request(), false, 'a running pass is marked to repeat');
  assert.equal(step(), false, 'finishing the stale pass starts the requested repeat');
  assert.equal(cull.pending, true);
  assert.equal(cull.cursor, 0, 'the repeat starts from the first unit');
  assert.equal(starts, 1);

  budget.begin();
  assert.equal(step(), false);
  assert.equal(step(), true);
  assert.equal(starts, 2, 'repeat-pass state is initialized independently');
  assert.equal(cull.pending, false);
});

test('restart abandons a stale partial pass after source data is published', () => {
  const budget = new ViewCullBudget({ budgetMs: 0, now: () => 0 });
  const cull = new IncrementalViewCull(budget);
  const applied = [];
  budget.begin();
  cull.request();
  cull.step([1, 2], (unit) => applied.push(unit));
  cull.restart();
  cull.step([1, 2], (unit) => applied.push(unit));
  assert.deepEqual(applied, [1, 1], 'the new source starts again at the first unit');
});

test('understory LOD only partitions instances kept by view culling', () => {
  const lod = new UnderstoryLod(5);
  const origins = new Float32Array([0, 0, 5, 0, 0, 15, 0, 0, 25, 0, 0, 35, 0, 0, 45]);
  const visible = new Uint32Array([1, 3]);
  lod.partition(origins, 5, { x: 0, z: 0 }, 22, 30, 2, visible, 2);
  assert.deepEqual([...lod.near.slice(0, lod.nearCount)], [1]);
  assert.deepEqual([...lod.far.slice(0, lod.farCount)], [3]);
});

test('cached cull spheres select exactly the instances the per-cull transform does', () => {
  const count = 2000;
  const camera = new PerspectiveCamera(65, 16 / 9, 0.1, 400);
  camera.position.set(0, 4, 0);
  const culler = new InstanceViewCuller(camera);
  const matrices = new Float32Array(count * 16);
  const matrix = new Matrix4(), rotation = new Quaternion(), position = new Vector3(), scale = new Vector3();
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const fill = () => {
    for (let i = 0; i < count; i++) {
      position.set((random() - 0.5) * 300, random() * 20, (random() - 0.5) * 300);
      rotation.setFromAxisAngle(new Vector3(0, 1, 0), random() * Math.PI * 2);
      scale.set(0.5 + random(), 0.5 + random() * 2, 0.5 + random());
      matrix.compose(position, rotation, scale).toArray(matrices, i * 16);
    }
  };
  fill();
  const local = new Sphere(new Vector3(0.3, 1.4, -0.2), 2);
  const cache = new InstanceSphereCache();
  const expected = new Uint32Array(count), actual = new Uint32Array(count);
  const compare = () => {
    const a = culler.collectVisible(matrices, count, local, expected);
    const b = culler.collectVisible(matrices, count, local, actual, cache);
    assert.equal(b, a);
    assert.deepEqual(actual.subarray(0, b), expected.subarray(0, a));
    return a;
  };
  for (let i = 0; i < 24; i++) {
    camera.rotation.y = i * Math.PI / 12;
    culler.update(true);
    const visible = compare();
    assert.ok(visible > 0 && visible < count);
  }
  // Republishing into the same array must be followed by invalidate().
  fill();
  cache.invalidate();
  compare();
  // Changed local bounds rebuild without an explicit invalidate.
  local.radius = 6;
  compare();
});

test('an instance selection memo matches only the same indices from the same source', () => {
  const memo = new InstanceSelectionMemo();
  assert.equal(memo.matches(1, new Uint32Array([1, 4, 5]), 3), false);
  assert.equal(memo.matches(1, new Uint32Array([1, 4, 5]), 3), true);
  assert.equal(memo.matches(1, new Uint32Array([1, 4, 6]), 3), false, 'same count, other instances');
  assert.equal(memo.matches(2, new Uint32Array([1, 4, 6]), 3), false, 'republished source');
  assert.equal(memo.matches(2, new Uint32Array([1, 4, 6, 9]), 2), false, 'shorter selection');
  assert.equal(memo.matches(2, new Uint32Array([1, 4]), 2), true);
  memo.invalidate();
  assert.equal(memo.matches(2, new Uint32Array([1, 4]), 2), false);
  assert.equal(memo.matches(0, new Uint32Array(0), 0), false);
  assert.equal(memo.matches(0, new Uint32Array(0), 0), true);
});
