import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_VEGETATION_CUTOFF,
  DEFAULT_VEGETATION_SOFTNESS,
  allowsVegetation,
  resolveVegetationPolicy,
  vegetationStrength,
} from '../src/grass/vegetationPolicy.js';

test('the cutoff gates the path fringe without shortening painted grass', () => {
  assert.equal(vegetationStrength(0), 0);
  assert.equal(vegetationStrength(0.3), 0, 'exactly at the cutoff nothing grows');
  assert.equal(vegetationStrength(0.05), 0, 'the old GRASS_CUTOFF fringe is now removed');
  assert.ok(vegetationStrength(0.35) > 0 && vegetationStrength(0.35) < 0.35, 'the ramp is continuous');
  for (const raw of [0.42, 0.6, 0.83, 1]) {
    assert.equal(vegetationStrength(raw), raw, `strength above the ramp is unchanged at ${raw}`);
  }
  assert.ok(allowsVegetation(vegetationStrength(1)));
  assert.ok(!allowsVegetation(vegetationStrength(0.2)));
});




test('the policy reads config with defaults', () => {
  assert.deepEqual(resolveVegetationPolicy({}), {
    cutoff: DEFAULT_VEGETATION_CUTOFF,
    softness: DEFAULT_VEGETATION_SOFTNESS,
    clearance: 0.5,
  });
  assert.deepEqual(
    resolveVegetationPolicy({ grass: { vegetationCutoff: 0.4, maskSoftness: 0.2, pathClearance: 1.5 } }),
    { cutoff: 0.4, softness: 0.2, clearance: 1.5 },
  );
});

