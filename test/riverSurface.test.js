import test from 'node:test';
import assert from 'node:assert/strict';
import { findRiverFalls, measureRiverSurface } from '../src/water/RiverCourse.js';

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

test('falls are found between a steep lip and a level foot, and rapids are not falls', () => {
  // Level, a 20 m drop, level, a 1.5 m riffle, level.
  const heights = i => i < 20 ? 60 : i < 40 ? 60 - (i - 20) : i < 70 ? 40 : i < 73 ? 40 - (i - 70) * 0.5 : 38.5;
  const samples = Array.from({ length: 100 }, (_, i) => ({ s: i * 1.5, y: heights(i) }));
  measureRiverSurface(samples);
  const falls = findRiverFalls(samples);
  assert.equal(falls.length, 1);
  const [fall] = falls;
  assert.ok(fall.lip >= 19 && fall.lip <= 21, `lip ${fall.lip}`);
  assert.ok(fall.foot >= 39 && fall.foot <= 42, `foot ${fall.foot}`);
  assert.ok(Math.abs(fall.drop - 20) < 1.5, `drop ${fall.drop}`);
  assert.ok(fall.peak > 0.6);
  assert.deepEqual(findRiverFalls([]), []);
});
