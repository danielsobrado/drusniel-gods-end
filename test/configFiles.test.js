import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_FILES } from '../src/config/loadConfig.js';

test('runtime config includes alpine terrain settings', () => {
  assert.ok(CONFIG_FILES.includes('alpine.yaml'));
  assert.ok(CONFIG_FILES.indexOf('alpine.yaml') > CONFIG_FILES.indexOf('snow.yaml'));
});
