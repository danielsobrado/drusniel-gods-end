import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coastalJungleKeepFraction,
  coastalJungleStableFraction,
  coastalJungleVisibilityLimit,
} from '../src/biome/CoastalJungleVisibility.js';

const render = {
  grassDenseDistance: 14,
  grassDistance: 34,
  grassFarDensity: 0.2,
  groundcoverDistance: 28,
  undergrowthDistance: 72,
  treeDistance: 180,
};

test('v2 visibility distances preserve the source runtime bands', () => {
  const quality = { maxDistance: 180, density: {} };
  assert.equal(coastalJungleVisibilityLimit('grass', render, quality), 34);
  assert.equal(coastalJungleVisibilityLimit('groundcover', render, quality), 28);
  assert.equal(coastalJungleVisibilityLimit('fern', render, quality), 72);
  assert.equal(coastalJungleVisibilityLimit('tree', render, quality), 180);
  assert.equal(coastalJungleVisibilityLimit('background_tree', render, quality), 180);
});

test('high quality keeps all near grass and thins only after 14 metres', () => {
  const quality = { maxDistance: 180, density: { grass: 1 } };
  assert.equal(coastalJungleKeepFraction('grass', 10, render, quality), 1);
  assert.equal(coastalJungleKeepFraction('grass', 14, render, quality), 1);
  assert.ok(coastalJungleKeepFraction('grass', 24, render, quality) < 1);
  assert.ok(Math.abs(coastalJungleKeepFraction('grass', 34, render, quality) - 0.2) < 1e-9);
});

test('quality density multiplies the stable grass thinning fraction', () => {
  const quality = { maxDistance: 160, density: { grass: 0.8, fern: 0.9 } };
  assert.equal(coastalJungleKeepFraction('grass', 10, render, quality), 0.8);
  assert.equal(coastalJungleKeepFraction('fern', 20, render, quality), 0.9);
  assert.ok(coastalJungleKeepFraction('grass', 30, render, quality) < 0.8);
});

test('stable visibility hashing is deterministic and spatially sensitive', () => {
  const position = { x: 12.345, y: 2.5, z: -8.75 };
  const first = coastalJungleStableFraction(position, 'grass');
  const second = coastalJungleStableFraction(position, 'grass');
  const moved = coastalJungleStableFraction({ ...position, x: 12.445 }, 'grass');
  assert.equal(first, second);
  assert.notEqual(first, moved);
  assert.ok(first >= 0 && first < 1);
});
