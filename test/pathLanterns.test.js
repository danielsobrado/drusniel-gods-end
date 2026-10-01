import test from 'node:test';
import assert from 'node:assert/strict';
import { LandscapePaths } from '../src/world/LandscapePaths.js';
import { createPathLanternPairs } from '../src/world/PathLanterns.js';

test('lantern pairs stand off roads, face inward and follow terrain height', () => {
  const paths = new LandscapePaths(1600);
  const terrain = { sampleHeight: (x, z) => x * 0.02 + z * 0.01 };
  const records = Array.from({ length: 20 }, (_, i) => [i * 13, 0, -i * 8, 0]);
  const lamps = createPathLanternPairs(records, paths, terrain, { sample: () => null });
  assert.equal(lamps.length, 20);
  for (let i = 0; i < lamps.length; i += 2) {
    const a = lamps[i], b = lamps[i + 1];
    assert.ok(paths.sample((a[0] + b[0]) / 2, (a[2] + b[2]) / 2) > 0.9);
    for (const [x, y, z, yaw] of [a, b]) {
      assert.equal(paths.sample(x, z), 0);
      assert.equal(y, terrain.sampleHeight(x, z));
      const towardX = (a[0] + b[0]) / 2 - x, towardZ = (a[2] + b[2]) / 2 - z;
      assert.ok(Math.cos(yaw) * towardX - Math.sin(yaw) * towardZ > 0);
    }
  }
});
