import assert from 'node:assert/strict';
import test from 'node:test';
import { isPostEffect, resolvePostEffects } from '../src/rendering/postEffects.js';

test('post effects fall back to the shipped look when config omits or garbles them', () => {
  assert.deepEqual(resolvePostEffects(undefined), {
    taa: false, bloom: true, lightShafts: false, depthOfField: false, sharpen: false,
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
