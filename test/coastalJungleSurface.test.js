import assert from 'node:assert/strict';
import test from 'node:test';
import { coastalJungleRouteOffset } from '../src/biome/CoastalJungleSurface.js';

test('coastal jungle floor stays above the terrain while yielding to routes', () => {
  assert.equal(coastalJungleRouteOffset(0.025, 0.015, 0), 0.025);
  assert.ok(Math.abs(coastalJungleRouteOffset(0.025, 0.015, 1) - 0.01) < 1e-9);
  assert.ok(coastalJungleRouteOffset(0.025, 1, 1) >= 0.006);
});

test('coastal jungle route offset clamps reveal to a stable range', () => {
  assert.equal(coastalJungleRouteOffset(0.025, 0.015, -2), 0.025);
  assert.ok(Math.abs(coastalJungleRouteOffset(0.025, 0.015, 5) - 0.01) < 1e-9);
});
