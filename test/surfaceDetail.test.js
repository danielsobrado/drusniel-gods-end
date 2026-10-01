import test from 'node:test';
import assert from 'node:assert/strict';
import { getSurfaceDetail, resolveSurfaceDetailConfig, SURFACE_DETAIL_EFFECTS } from '../src/rendering/surfaceDetail.js';
import { isTouchPrimary } from '../src/player/touchInput.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

test('the shipped surface detail resolves with every effect switched on', async () => {
  const config = await loadMergedConfig();
  const settings = resolveSurfaceDetailConfig(config);
  assert.equal(settings.enabled, true);
  assert.ok(settings.rock.streaks.strength > 0);
  assert.ok(settings.blend.distance[1] > settings.blend.distance[0]);
  // Pebbles stay a sparse scatter.
  assert.ok(settings.pebbles.strand <= 0.1 && settings.pebbles.density <= 0.05);
  const state = getSurfaceDetail(config);
  for (const name of SURFACE_DETAIL_EFFECTS) assert.equal(typeof state[name].value, 'number', name);
  // One state per config: materials built from it share the uniforms.
  assert.equal(getSurfaceDetail(config), state);
});

test('a missing or disabled surfaceDetail zeroes every strength', () => {
  for (const config of [{}, { surfaceDetail: { enabled: false } }]) {
    const settings = resolveSurfaceDetailConfig(config);
    assert.equal(settings.enabled, false);
    assert.equal(settings.rock.streaks.strength, 0);
    assert.equal(settings.pebbles.strength, 0);
    assert.equal(settings.bark.moss, 0);
    assert.equal(settings.beachScatter.enabled, false);
  }
});

test('surface detail rejects values out of range by path', () => {
  assert.throws(() => resolveSurfaceDetailConfig({ surfaceDetail: { rock: { streaks: { strength: 2 } } } }),
    /surfaceDetail\.rock\.streaks\.strength/);
  assert.throws(() => resolveSurfaceDetailConfig({ surfaceDetail: { pebbles: { strandHeight: [2, 1] } } }),
    /strandHeight/);
  assert.throws(() => resolveSurfaceDetailConfig({ surfaceDetail: { blend: { distance: [100, 50] } } }),
    /blend\.distance/);
});

test('touch-primary means no hover and a coarse pointer', () => {
  const runtime = (matches) => ({ matchMedia: (query) => ({ matches: matches(query) }) });
  assert.equal(isTouchPrimary(runtime(() => true)), true);
  // A desktop (fine pointer) or a touch laptop with a mouse does not match.
  assert.equal(isTouchPrimary(runtime(() => false)), false);
  assert.equal(isTouchPrimary({}), false);
});
