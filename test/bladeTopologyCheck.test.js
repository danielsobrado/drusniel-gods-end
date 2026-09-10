import assert from 'node:assert/strict';
import test from 'node:test';
import { diffRgba } from '../scripts/gpu/blade-topology-check.js';

test('identical images report no pixel change', () => {
  const pixels = new Uint8Array([10, 20, 30, 255, 1, 2, 3, 255]);
  const diff = diffRgba(pixels, pixels);
  assert.equal(diff.pixels, 2);
  assert.equal(diff.changed, 0);
  assert.equal(diff.maxDelta, 0);
  assert.equal(diff.meanDelta, 0);
});

test('channel differences count a changed pixel and keep the max delta', () => {
  const shared = new Uint8Array([10, 20, 30, 255, 0, 0, 0, 255]);
  const duplicated = new Uint8Array([12, 20, 30, 255, 0, 0, 0, 255]);
  const diff = diffRgba(shared, duplicated);
  assert.equal(diff.changed, 1);
  assert.equal(diff.maxDelta, 2);
  assert.equal(diff.changedShare, 0.5);
});
