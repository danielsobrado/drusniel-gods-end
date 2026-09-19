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

test('water speeds up down a fall and slows at its foot, pacing the travel time the streaks ride on', () => {
  const samples = Array.from({ length: 35 }, (_, i) => ({ s: i * 2, y: i < 6 ? 20 : i < 12 ? 20 - (i - 5) * 2 : 8 }));
  measureRiverSurface(samples);
  assert.ok(samples[3].flowSpeed < 1.5, 'level water runs slowly');
  assert.ok(samples[11].flowSpeed > 4, 'water is fast by the foot of the fall');
  assert.ok(samples[30].flowSpeed < 2 && samples[30].flowSpeed < samples[14].flowSpeed, 'and slows below it');
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i].travelTime > samples[i - 1].travelTime);
  // Seconds per metre of surface: the fall is crossed far faster than the level,
  // so a texture carried on travel time stretches down the fall.
  const pace = (a, b) => (samples[b].travelTime - samples[a].travelTime)
    / (samples[b].surfaceDistance - samples[a].surfaceDistance);
  assert.ok(pace(9, 11) < pace(1, 3) / 2.5);
});
