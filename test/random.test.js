import test from 'node:test';
import assert from 'node:assert/strict';
import { createRandom } from '../src/utils/random.js';

// Determinism here is a world-stability property, not an implementation detail: tree
// scale and rotation, bird orbit parameters and leaf placement all derive from
// this generator. If its constants drift the whole world silently reshuffles,
// and nothing else in the repository would notice.
//
// The arrays below are golden values captured from the current implementation.
// A failure means the generator changed, which is either a bug or a deliberate
// world reshuffle that needs a visual re-baseline. Do not "fix" a
// failure by pasting in new numbers without making that decision explicitly.

const GOLDEN_DEFAULT_SEED = [
  0.0003297457005828619,
  0.2232720274478197,
  0.1462021479383111,
  0.46732782293111086,
  0.5450490827206522,
  0.6152513844426721,
];

const GOLDEN_SEED_12345 = [
  0.9797282677609473,
  0.3067522644996643,
  0.484205421525985,
  0.817934412509203,
  0.5094283693470061,
  0.34747186047025025,
];

function take(random, count) {
  return Array.from({ length: count }, () => random());
}

test('default seed produces the golden sequence', () => {
  assert.deepEqual(take(createRandom(), GOLDEN_DEFAULT_SEED.length), GOLDEN_DEFAULT_SEED);
});

test('explicit seed produces the golden sequence', () => {
  assert.deepEqual(take(createRandom(12345), GOLDEN_SEED_12345.length), GOLDEN_SEED_12345);
});

test('same seed produces the same sequence', () => {
  assert.deepEqual(take(createRandom(777), 32), take(createRandom(777), 32));
});

test('different seeds diverge', () => {
  assert.notDeepEqual(take(createRandom(1), 8), take(createRandom(2), 8));
});

test('values stay within [0, 1)', () => {
  const random = createRandom(0xabcdef);
  for (let index = 0; index < 10000; index += 1) {
    const value = random();
    assert.ok(value >= 0 && value < 1, `value out of range: ${value}`);
  }
});
