import assert from 'node:assert/strict';
import test from 'node:test';
import { clamp, createSeededRandom, damp } from '../src/core/math.js';

test('clamp limits values', () => {
  assert.equal(clamp(-2, 0, 5), 0);
  assert.equal(clamp(7, 0, 5), 5);
  assert.equal(clamp(3, 0, 5), 3);
});

test('damp approaches the target without overshooting', () => {
  const value = damp(0, 10, 8, 1 / 60);
  assert.ok(value > 0 && value < 10);
});

test('seeded random is reproducible', () => {
  const first = createSeededRandom(42);
  const second = createSeededRandom(42);
  assert.deepEqual([first(), first(), first()], [second(), second(), second()]);
});
