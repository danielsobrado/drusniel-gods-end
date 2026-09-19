import test from 'node:test';
import assert from 'node:assert/strict';
import { createSprayPuffTexture, createWaterfallTexture } from '../src/water/waterfallTexture.js';

test('waterfall detail is deterministic, tiles seamlessly, spreads evenly and streaks down the fall', () => {
  const a = createWaterfallTexture(), b = createWaterfallTexture();
  try {
    assert.deepEqual(a.image.data, b.image.data);
    const { data, width, height } = a.image;
    const at = (x, y, channel) => data[(((y + height) % height) * width + ((x + width) % width)) * 4 + channel];
    // Mean step between two columns (or rows), wrapping at the tile edge.
    const columnStep = (x, channel) => {
      let sum = 0;
      for (let y = 0; y < height; y += 1) sum += Math.abs(at(x + 1, y, channel) - at(x, y, channel));
      return sum / height;
    };
    const rowStep = (y, channel) => {
      let sum = 0;
      for (let x = 0; x < width; x += 1) sum += Math.abs(at(x, y + 1, channel) - at(x, y, channel));
      return sum / width;
    };
    const streak = [];
    for (const channel of [0, 1, 2]) {
      let sum = 0, low = 0, across = 0, down = 0;
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
        const value = at(x, y, channel);
        sum += value;
        if (value < 64) low += 1;
        across += Math.abs(at(x + 1, y, channel) - value);
        down += Math.abs(at(x, y + 1, channel) - value);
      }
      // Equalized, so a foam threshold of 1 - coverage whitens about `coverage`.
      assert.ok(Math.abs(sum / (width * height) - 127.5) < 3, `channel ${channel} mean`);
      assert.ok(Math.abs(low / (width * height) - 0.25) < 0.03, `channel ${channel} lowest quarter`);
      // The step across each wrap is like the steps beside it, not a seam.
      const besideAcross = (columnStep(width - 2, channel) + columnStep(0, channel)) / 2;
      const besideDown = (rowStep(height - 2, channel) + rowStep(0, channel)) / 2;
      assert.ok(columnStep(width - 1, channel) < besideAcross * 1.6 + 1, `channel ${channel} tiles across`);
      assert.ok(rowStep(height - 1, channel) < besideDown * 1.6 + 1, `channel ${channel} tiles down`);
      streak.push(across / down);
    }
    // Per texel, strands change far faster across the fall than down it, and a
    // texel spans several times more metres down a fall than across it.
    assert.ok(streak[0] > 2, `strands streak (${streak[0].toFixed(2)})`);
    assert.ok(streak[1] > 1.2, `sheets streak (${streak[1].toFixed(2)})`);
  } finally {
    a.dispose();
    b.dispose();
  }
});

test('spray puffs are soft, clear at the quad edge, dense inside and different in each channel', () => {
  const puffs = createSprayPuffTexture();
  try {
    const { data, width: size } = puffs.image;
    const at = (x, y, channel) => data[(y * size + x) * 4 + channel];
    const means = [];
    for (let channel = 0; channel < 4; channel += 1) {
      let edge = 0, inner = 0, innerCount = 0;
      for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
        const radius = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5) * 2;
        const value = at(x, y, channel);
        if (x === 0 || y === 0 || x === size - 1 || y === size - 1) edge = Math.max(edge, value);
        if (radius < 0.35) { inner += value; innerCount += 1; }
      }
      // A square billboard must never show its outline.
      assert.equal(edge, 0, `channel ${channel} edge`);
      means.push(inner / innerCount);
      assert.ok(means[channel] > 140, `channel ${channel} core ${means[channel].toFixed(0)}`);
    }
    let differing = 0;
    for (let k = 0; k < size * size; k += 1) if (Math.abs(data[k * 4] - data[k * 4 + 1]) > 24) differing += 1;
    assert.ok(differing > size * size * 0.1, 'variants are distinct shapes');
  } finally {
    puffs.dispose();
  }
});
