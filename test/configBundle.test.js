import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigBundleJson } from '../scripts/generate-config-bundle.mjs';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

test('runtime config bundle matches the effective YAML merge', async () => {
  const bundled = JSON.parse(await createConfigBundleJson());
  assert.deepEqual(bundled, await loadMergedConfig());
});
