import assert from 'node:assert/strict';
import test from 'node:test';
import { isPostEffect, isPostLevel, resolvePostEffects, resolvePostLevels } from '../src/rendering/postEffects.js';

test('post effects fall back to the shipped look when config omits or garbles them', () => {
  assert.deepEqual(resolvePostEffects(undefined), {
    taa: false, bloom: true, lightShafts: false, depthOfField: true, sharpen: false,
    grain: true, vignette: true, tonemapper: 'aces',
  });
  const resolved = resolvePostEffects({ effects: { taa: true, bloom: 'no', tonemapper: 'filmic' } });
  assert.equal(resolved.taa, true);
  assert.equal(resolved.bloom, true, 'non-boolean toggles are ignored');
  assert.equal(resolved.tonemapper, 'aces', 'unknown tonemappers are ignored');
});

test('only known effects with the right value type are accepted', () => {
  assert.equal(isPostEffect('tonemapper', 'agx'), true);
  assert.equal(isPostEffect('tonemapper', true), false);
  assert.equal(isPostEffect('depthOfField', false), true);
  assert.equal(isPostEffect('depthOfField', 'on'), false);
  assert.equal(isPostEffect('ssr', true), false);
});

test('depth of field levels clamp to their slider range', () => {
  assert.deepEqual(resolvePostLevels(undefined), { focalRange: 34, bokehScale: 0.7 });
  assert.deepEqual(resolvePostLevels({ depthOfField: { focalRange: 28, bokehScale: 0.9 } }),
    { focalRange: 28, bokehScale: 0.9 });
  const clamped = resolvePostLevels({ depthOfField: { focalRange: 500, bokehScale: 'wide' } });
  assert.equal(clamped.focalRange, 60, 'out-of-range levels clamp');
  assert.equal(clamped.bokehScale, 0.7, 'non-numeric levels fall back');
});

test('only known levels inside their range are accepted', () => {
  assert.equal(isPostLevel('focalRange', 40), true);
  assert.equal(isPostLevel('focalRange', 200), false);
  assert.equal(isPostLevel('bokehScale', Number.NaN), false);
  assert.equal(isPostLevel('focusDistance', 6), false, 'focus distance stays pipeline-driven');
});
