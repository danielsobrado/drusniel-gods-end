import test from 'node:test';
import assert from 'node:assert/strict';
import { measureRiverSurface } from '../src/water/RiverCourse.js';

test('cascade texture distance follows the falling surface and impact foam decays downstream', () => {
  const samples = Array.from({ length: 35 }, (_, i) => ({ s: i * 2, y: i < 6 ? 20 : i < 12 ? 20 - (i - 5) * 2 : 8 }));
  measureRiverSurface(samples);
  assert.ok(samples[12].surfaceDistance > samples[12].s + 4);
  assert.ok(samples[8].slope > 0.9);
  assert.equal(samples[20].slope, 0);
  assert.ok(samples[12].impact > 0.5);
  assert.ok(samples[20].impact < samples[12].impact && samples[20].impact > 0);
  assert.ok(samples[34].impact < 0.02);
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i].surfaceDistance > samples[i - 1].surfaceDistance);
});
