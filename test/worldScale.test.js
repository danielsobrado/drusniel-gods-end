import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorldScale, validateWorldScaleConfig } from '../src/world/worldScale.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

test('the world scale contract derives units per metre from a human', () => {
  const scale = resolveWorldScale({ world: { scale: { humanHeight: 5, humanMetres: 2 } } });
  assert.equal(scale.unitsPerMetre, 2.5);
  assert.deepEqual(resolveWorldScale({}), { humanHeight: 5, humanMetres: 1.8, unitsPerMetre: 5 / 1.8 });
});

test('invalid world scale values are reported', () => {
  const problems = [];
  validateWorldScaleConfig({ world: { scale: { humanHeight: 0, humanMetres: 'x' } } }, problems);
  assert.equal(problems.length, 2);
});

test('the shipped human characters stand at the contract height', async () => {
  const config = await loadMergedConfig();
  const { humanHeight } = resolveWorldScale(config);
  assert.equal(config.player.targetHeight, humanHeight, 'the default avatar is the contract human');
});
