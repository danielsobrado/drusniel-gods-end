import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMobileStartupProfile,
  isMobileStartup,
  mobileWarmupTravelDistance,
} from '../src/config/mobileStartup.js';

function runtime(width, height, coarsePointer) {
  return {
    innerWidth: width,
    innerHeight: height,
    matchMedia: () => ({ matches: coarsePointer }),
  };
}

function config() {
  return {
    renderer: { pixelRatioCap: 2 },
    quality: { performance: {}, high: {} },
    ui: {
      initialQuality: 'high',
      mobileStartup: {
        enabled: true,
        maxShortSide: 900,
        requireCoarsePointer: true,
        initialQuality: 'performance',
        pixelRatioCap: 1.25,
        warmupTravelDistance: 25,
      },
    },
  };
}

test('mobile startup uses the short viewport side and coarse pointer', () => {
  const value = config();
  assert.equal(isMobileStartup(value, runtime(915, 412, true)), true);
  assert.equal(isMobileStartup(value, runtime(1440, 900, false)), false);
  assert.equal(isMobileStartup(value, runtime(1920, 1080, true)), false);
});

test('mobile startup applies performance quality and caps DPR without raising a lower cap', () => {
  const value = config();
  assert.equal(applyMobileStartupProfile(value, runtime(915, 412, true)), true);
  assert.equal(value.ui.initialQuality, 'performance');
  assert.equal(value.renderer.pixelRatioCap, 1.25);

  value.renderer.pixelRatioCap = 1;
  applyMobileStartupProfile(value, runtime(915, 412, true));
  assert.equal(value.renderer.pixelRatioCap, 1);
  assert.equal(mobileWarmupTravelDistance(value), 25);
});

test('desktop startup remains unchanged', () => {
  const value = config();
  assert.equal(applyMobileStartupProfile(value, runtime(1440, 900, false)), false);
  assert.equal(value.ui.initialQuality, 'high');
  assert.equal(value.renderer.pixelRatioCap, 2);
});
