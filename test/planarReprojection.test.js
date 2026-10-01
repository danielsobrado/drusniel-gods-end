import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, PerspectiveCamera } from 'three';
import { PlanarReprojection, resolveOverscan } from '../src/water/PlanarReprojection.js';

function fakeReflector() {
  const virtual = new PerspectiveCamera();
  return {
    virtual,
    reflector: { hasOutput: true, getVirtualCamera: () => virtual },
  };
}

test('overscan accepts a number or an [x, y] pair and falls back for bad values', () => {
  assert.deepEqual(resolveOverscan(undefined), [1.35, 1.15]);
  assert.deepEqual(resolveOverscan(1.2), [1.2, 1.2]);
  assert.deepEqual(resolveOverscan([1.5, 1.1]), [1.5, 1.1]);
  assert.deepEqual(resolveOverscan([0.5, 'x']), [1.35, 1.15]);
});

test('captures widen the camera frustum only while rendering and record the capture camera', () => {
  const node = fakeReflector();
  const reprojection = new PlanarReprojection(node, { overscan: [1.5, 1.25] });
  const camera = new PerspectiveCamera(50, 2, 0.1, 1000);
  const original = camera.projectionMatrix.clone();
  let during = null;
  reprojection.capture(camera, () => {
    during = camera.projectionMatrix.clone();
    node.virtual.projectionMatrix.copy(camera.projectionMatrix);
    node.virtual.position.set(0, -5, 0);
    node.virtual.updateMatrixWorld();
  });
  assert.ok(Math.abs(during.elements[0] - original.elements[0] / 1.5) < 1e-9);
  assert.ok(Math.abs(during.elements[5] - original.elements[5] / 1.25) < 1e-9);
  assert.ok(camera.projectionMatrix.equals(original), 'main camera projection is restored');
  const expected = new Matrix4().multiplyMatrices(node.virtual.projectionMatrix, node.virtual.matrixWorldInverse);
  assert.ok(reprojection.viewProjection.value.equals(expected));
  assert.equal(reprojection.valid.value, 1);
});

test('a capture that produced no output invalidates the reprojection and a throwing render still restores', () => {
  const node = fakeReflector();
  const reprojection = new PlanarReprojection(node);
  const camera = new PerspectiveCamera();
  const original = camera.projectionMatrix.clone();
  node.reflector.hasOutput = false;
  reprojection.capture(camera, () => {});
  assert.equal(reprojection.valid.value, 0);
  assert.throws(() => reprojection.capture(camera, () => { throw new Error('boom'); }));
  assert.ok(camera.projectionMatrix.equals(original));
});
