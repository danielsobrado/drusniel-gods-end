import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFallbackTreeImpostorData } from '../src/foliage/TreeImpostorMaps.js';

const FALLBACK = {
  normalSampleRadius: 1,
  normalStrength: 1.25,
  maskSignalLow: 0.07,
  maskSignalHigh: 0.18,
  maskBrightnessLow: 0.08,
  maskBrightnessHigh: 0.25,
  greenRedWeight: 0.55,
  greenBlueWeight: 0.45,
  yellowWeight: 0.65,
  chromaWeight: 0.12,
};

test('fallback tree impostor mask separates leafy green from brown bark', () => {
  const rgba = new Uint8Array([
    100, 60, 30, 255,
    50, 160, 30, 255,
  ]);
  const packed = buildFallbackTreeImpostorData(rgba, 2, 1, { views: 1, tileSize: 2 }, FALLBACK);
  assert.ok(packed[2] < 64, `bark mask must stay low: ${packed[2]}`);
  assert.ok(packed[6] > 192, `leaf mask must stay high: ${packed[6]}`);
  assert.equal(packed[3], 255);
  assert.equal(packed[7], 255);
});

test('fallback tree impostor normals use alpha silhouette gradients without crossing atlas views', () => {
  const width = 10, height = 5, rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const visible = (x >= 2 && x <= 4) || (x >= 6 && x <= 8);
    const index = (y * width + x) * 4;
    rgba[index] = 40; rgba[index + 1] = 150; rgba[index + 2] = 30;
    rgba[index + 3] = visible ? 255 : 0;
  }
  const packed = buildFallbackTreeImpostorData(rgba, width, height, { views: 2, tileSize: 5 }, FALLBACK);
  const boundary = (2 * width + 2) * 4;
  const interior = (2 * width + 3) * 4;
  assert.notEqual(packed[boundary], 128, 'silhouette edge must bend the packed normal');
  assert.ok(Math.abs(packed[interior] - 128) <= 1, 'interior normal must remain camera-facing');
  const secondViewEdge = (2 * width + 6) * 4;
  assert.notEqual(packed[secondViewEdge], 128, 'second atlas view keeps its own edge gradient');
});
