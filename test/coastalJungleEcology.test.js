import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCoastalJungleRuntimeActive,
  setCoastalJungleRuntimeActive,
} from '../src/biome/CoastalJungleRuntime.js';

test('coastal jungle ecology activation is runtime-only and fail-open', () => {
  const config = {};
  assert.equal(isCoastalJungleRuntimeActive(config), false);
  setCoastalJungleRuntimeActive(config, true);
  assert.equal(isCoastalJungleRuntimeActive(config), true);
  setCoastalJungleRuntimeActive(config, false);
  assert.equal(isCoastalJungleRuntimeActive(config), false);
});
