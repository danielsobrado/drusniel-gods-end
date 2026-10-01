import test from 'node:test';
import assert from 'node:assert/strict';
import { Frustum, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { TurnEnvelopeFrustum } from '../src/rendering/TurnEnvelopeFrustum.js';

function horizontalRightAngle(camera) {
  const elements = camera.projectionMatrix.elements;
  return Math.atan((1 + elements[8]) / elements[0]);
}

test('turn envelope preserves the requested horizontal margin on ultrawide cameras', () => {
  const camera = new PerspectiveCamera(60, 32 / 9, 0.1, 500);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const targetAngle = horizontalRightAngle(camera) + 11.5 * Math.PI / 180;
  const point = new Vector3(Math.sin(targetAngle) * 100, 0, -Math.cos(targetAngle) * 100);

  const exact = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    camera.coordinateSystem,
  );
  assert.equal(exact.containsPoint(point), false);

  const envelope = new TurnEnvelopeFrustum();
  envelope.update(camera, 12);
  assert.equal(envelope.frustum.containsPoint(point), true);
});

test('turn envelope preserves asymmetric projection offsets', () => {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 500);
  camera.setViewOffset(1920, 1080, 240, 0, 1680, 1080);
  camera.updateMatrixWorld();

  const elements = camera.projectionMatrix.elements;
  const leftAngle = Math.atan((-1 + elements[8]) / elements[0]);
  const targetAngle = leftAngle - 11.5 * Math.PI / 180;
  const point = new Vector3(Math.sin(targetAngle) * 100, 0, -Math.cos(targetAngle) * 100);

  const envelope = new TurnEnvelopeFrustum();
  envelope.update(camera, 12);
  assert.equal(envelope.frustum.containsPoint(point), true);
});
