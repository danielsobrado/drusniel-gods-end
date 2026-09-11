import assert from 'node:assert/strict';
import test from 'node:test';
import { capPopulation, resolvePopulationCap, comparePopulation } from '../src/foliage/populationCap.js';
import { resolveWildGrassSettings } from '../src/foliage/wildGrassPlacement.js';
import { resolveUnderstorySettings } from '../src/foliage/understoryPlacement.js';
import { setReferenceBiomeEnabled } from '../src/config/resolvePresetConfig.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

test('caps sort by distance then stable id before truncating', () => {
  const records = [
    { id: 'b', x: 4, z: 0 },
    { id: 'a', x: 4, z: 0 },
    { id: 'c', x: 1, z: 0 },
  ];
  capPopulation(records, 2, { x: 0, z: 0 });
  assert.deepEqual(records.map((r) => r.id), ['c', 'a']);
  assert.ok(comparePopulation({ id: 'a', x: 0, z: 0 }, { id: 'b', x: 0, z: 0 }) < 0);
});

test('quality tables resolve the shared wild-grass and understory caps', async () => {
  const config = await loadMergedConfig();
  assert.equal(resolvePopulationCap({ performance: 96, high: 240 }, 'performance'), 96);
  const original = resolveWildGrassSettings(config, 'sunny', 'high');
  assert.equal(original.castShadow, true);
  assert.equal(original.maxInstancesTotal, undefined);
  setReferenceBiomeEnabled(config, true);
  const wild = resolveWildGrassSettings(config, 'sunny', 'high');
  const under = resolveUnderstorySettings(config, 'windy', 'performance');
  assert.equal(wild.castShadow, false);
  assert.equal(wild.maxInstancesTotal, 240);
  assert.equal(under.castShadow, false);
  assert.equal(under.maxInstancesTotal, 64);
  setReferenceBiomeEnabled(config, false);
  assert.equal(resolveWildGrassSettings(config, 'sunny', 'high').maxInstancesTotal, undefined);
});
