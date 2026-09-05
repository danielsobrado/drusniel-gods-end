import assert from 'node:assert/strict';
import test from 'node:test';
import { createGrassGeometry } from '../src/grass/GrassGeometry.js';
import { compactGrassGeometry } from '../src/grass/compactGrassGeometry.js';
import { sampleGrassMask } from '../src/grass/sampleGrassMask.js';

test('cinematic grass LODs retain the exact positions, rotations and identities of surviving blades', () => {
  const make = (density, detail) => createGrassGeometry({ type: 'blade', density, detail, tileSize: 25, bladeHeight: 1, stable: true });
  const high = make(5.5, 5);
  const low = make(2, 2);
  try {
    assert.equal(high.instanceCount, 137 ** 2, 'keep the configured high-density blade count');
    for (const name of ['instancePosition', 'instanceRotation', 'instanceData']) {
      const a = high.getAttribute(name).array;
      const b = low.getAttribute(name).array;
      assert.deepEqual(a.slice(0, b.length), b, name);
    }
  } finally { high.dispose(); low.dispose(); }
});

test('path compaction preserves every unmasked blade and its original LOD identity', () => {
  const source = createGrassGeometry({ type: 'blade', density: 2, detail: 3, tileSize: 25, stable: true });
  const compact = compactGrassGeometry(source, 100, -40, (x) => x >= 100);
  const positions = source.getAttribute('instancePosition');
  const identities = compact.getAttribute('instanceData');
  const expected = Array.from({ length: source.instanceCount }, (_, i) => i).filter(i => positions.getX(i) >= 0);
  assert.equal(compact.instanceCount, expected.length);
  assert.deepEqual(Array.from({ length: compact.instanceCount }, (_, i) => identities.getY(i)), expected);
  const full = compactGrassGeometry(source, 0, 0, () => true);
  assert.equal(full.instanceCount, source.instanceCount);
  source.dispose(); compact.dispose(); full.dispose();
});

test('mask compaction respects linear-filtered edges instead of dropping a partly grass-covered square', () => {
  const image = { width: 2, height: 2, data: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255]) };
  assert.equal(sampleGrassMask(image, 0.25, 0.5), 0);
  assert.equal(sampleGrassMask(image, 0.75, 0.5), 1);
  assert.equal(sampleGrassMask(image, 0.5, 0.5), 0.5);
  assert.ok(sampleGrassMask(image, 0.251, 0.5) > 0);
});
