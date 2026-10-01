import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_FILES } from '../src/config/loadConfig.js';

test('runtime config includes alpine terrain settings', () => {
  assert.ok(CONFIG_FILES.includes('alpine.yaml'));
  assert.ok(CONFIG_FILES.indexOf('alpine.yaml') > CONFIG_FILES.indexOf('snow.yaml'));
});

test('visual refinement is the final art-direction override', () => {
  assert.equal(CONFIG_FILES.at(-1), 'visual-refinement.yaml');
  assert.ok(CONFIG_FILES.indexOf('visual-refinement.yaml') > CONFIG_FILES.indexOf('reference-biome.yaml'));
});
