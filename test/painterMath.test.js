import assert from 'node:assert/strict';
import test from 'node:test';
import {
  brushRadiusPixels,
  heightToPaintValue,
  strokeSpacingUv,
} from '../src/grass/painterMath.js';

const TERRAIN_SPAN = 370;
const MASK_RESOLUTION = 1024;
const STROKE_SPACING = 0.3;
const HEIGHT_MAPPING = Object.freeze({
  minHeight: 1,
  maxHeight: 10,
  maskRange: 200,
});

test('recovered painter brush radius maps world units to mask pixels', () => {
  assert.equal(brushRadiusPixels(5, MASK_RESOLUTION, TERRAIN_SPAN), 13);
  assert.equal(brushRadiusPixels(100, MASK_RESOLUTION, TERRAIN_SPAN), 276);
});

test('recovered painter stroke spacing is based on terrain span', () => {
  assert.equal(strokeSpacingUv(5, TERRAIN_SPAN, STROKE_SPACING), 1.5 / TERRAIN_SPAN);
});

test('recovered painter blade-height mapping preserves grayscale values', () => {
  assert.equal(heightToPaintValue(1, HEIGHT_MAPPING), 200);
  assert.equal(heightToPaintValue(5, HEIGHT_MAPPING), 111);
  assert.equal(heightToPaintValue(10, HEIGHT_MAPPING), 0);
  assert.equal(heightToPaintValue(99, HEIGHT_MAPPING), 0);
});
