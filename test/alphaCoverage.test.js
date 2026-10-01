import test from 'node:test';
import assert from 'node:assert/strict';
import { foliageMipmaps } from '../src/foliage/alphaCoverage.js';

function coverage(level, cutoff = 0.35) {
  let covered = 0;
  for (let index = 3; index < level.data.length; index += 4) {
    if (level.data[index] / 255 >= cutoff) covered += 1;
  }
  return covered / (level.width * level.height);
}

test('foliage mipmaps retain cutout coverage while reducing to 1x1', () => {
  const data = new Uint8Array(4 * 4 * 4);
  for (let pixel = 0; pixel < 16; pixel += 1) {
    const offset = pixel * 4;
    data[offset] = 80;
    data[offset + 1] = 150;
    data[offset + 2] = 60;
    data[offset + 3] = pixel < 8 ? 255 : 0;
  }

  const levels = foliageMipmaps(data, 4, 4);
  assert.deepEqual(levels.map(({ width, height }) => [width, height]), [[4, 4], [2, 2], [1, 1]]);
  assert.ok(coverage(levels[1]) >= 0.5);
  assert.equal(levels.at(-1).data.length, 4);
});
