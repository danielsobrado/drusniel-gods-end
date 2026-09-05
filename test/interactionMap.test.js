import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionMap } from '../src/grass/InteractionMap.js';
import { createRandom } from '../src/utils/random.js';

// Differential harness for the InteractionMap optimization.
//
// The optimization skips the 65,536-iteration recovery pass and the 256KB
// texture upload when no ink is present. The claim is that this is BIT-EXACT,
// not merely close, so the test drives the live implementation through a
// randomized walk and compares it byte-for-byte against a reference that always
// does the full work.
//
// The disable-then-idle stretch is the important part. visual-parity-checklist
// requires that disabling foot interaction lets existing bends FADE rather than
// freezing them, so an optimization keyed on `enabled` instead of on ink would
// fail here.

const CONFIG = {
  grass: {
    interaction: {
      enabled: true,
      resolution: 256,
      worldSize: 75,
      recoverySpeed: 0.94,
      footRadius: 0.72,
      strength: 1,
    },
  },
};

// Flat terrain: every optimization under test is independent of height.
const TERRAIN = { sampleHeight: () => 0 };

// Always-full-work reference: mirrors the pre-optimization implementation.
class ReferenceMap extends InteractionMap {
  update(playerPosition, influencePoints = []) {
    const nextCenter = { x: playerPosition.x, y: playerPosition.z };
    if (this.lastCenter.lengthSq() === 0) this.lastCenter.set(nextCenter.x, nextCenter.y);
    this.forceScroll(nextCenter.x - this.lastCenter.x, nextCenter.y - this.lastCenter.y);
    this.lastCenter.set(nextCenter.x, nextCenter.y);
    this.center.set(nextCenter.x, nextCenter.y);
    this.forceRecover();
    if (this.enabled) {
      if (influencePoints.length === 0) {
        this.paintSphere(playerPosition.x, playerPosition.y, playerPosition.z, 0.72, this.strength);
      } else {
        for (const point of influencePoints) {
          this.paintSphere(point.position.x, point.position.y, point.position.z, point.radius, this.strength);
        }
      }
    }
    this.texture.needsUpdate = true;
  }
}

function makePair() {
  return {
    live: new InteractionMap(CONFIG, TERRAIN),
    reference: new ReferenceMap(CONFIG, TERRAIN),
  };
}

function assertIdentical(live, reference, step) {
  const a = live.pixels;
  const b = reference.pixels;
  assert.equal(a.length, b.length, `buffer length changed at step: ${step}`);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      assert.fail(
        `pixel buffers diverged at step: ${step} (byte ${index}: ${a[index]} vs ${b[index]})`,
      );
    }
  }
}

function drive(pair, position, points, step) {
  pair.live.update(position, points);
  pair.reference.update(position, points);
  assertIdentical(pair.live, pair.reference, step);
}

test('idle with no ink stays identical', () => {
  const pair = makePair();
  pair.live.setEnabled(false);
  pair.reference.setEnabled(false);
  for (let frame = 0; frame < 50; frame += 1) {
    drive(pair, { x: 0, y: 0, z: 0 }, [], `idle frame ${frame}`);
  }
});

test('painting then decaying to zero stays identical', () => {
  const pair = makePair();
  drive(pair, { x: 0, y: 0, z: 0 }, [], 'paint');
  // 0.94^n reaches zero well inside 400 frames.
  for (let frame = 0; frame < 400; frame += 1) {
    pair.live.setEnabled(false);
    pair.reference.setEnabled(false);
    drive(pair, { x: 0, y: 0, z: 0 }, [], `decay frame ${frame}`);
  }
  assert.ok(pair.live.pixels.every((v, i) => (i % 4 === 3 ? v === 255 : v === 0)), 'ink fully decayed');
});

// The criterion the naive optimization violates.
// Ink lives in the red channel only; alpha is always 255, so a plain max over
// the buffer would just report 255 forever.
function maxInk(map) {
  let max = 0;
  for (let index = 0; index < map.pixels.length; index += 4) {
    if (map.pixels[index] > max) max = map.pixels[index];
  }
  return max;
}

test('disabling stops new bending but existing influence still fades', () => {
  const map = new InteractionMap(CONFIG, TERRAIN);
  map.update({ x: 0, y: 0, z: 0 }, []);
  const afterPaint = maxInk(map);
  assert.ok(afterPaint > 0, 'expected ink after painting');

  map.setEnabled(false);
  map.update({ x: 0, y: 0, z: 0 }, []);
  const afterOneFade = maxInk(map);

  assert.ok(afterOneFade < afterPaint, 'existing influence must keep fading while disabled');
  assert.ok(afterOneFade > 0, 'one frame should not erase everything');
});

test('randomized walk stays byte-identical', () => {
  const pair = makePair();
  const random = createRandom(20260904);
  let x = 0;
  let z = 0;

  for (let frame = 0; frame < 120; frame += 1) {
    const phase = frame % 30;
    const enabled = phase < 15;
    pair.live.setEnabled(enabled);
    pair.reference.setEnabled(enabled);

    // Alternate standing still with movement large enough to actually scroll.
    if (phase % 10 < 5) {
      x += (random() - 0.5) * 8;
      z += (random() - 0.5) * 8;
    }

    const points = frame % 7 === 0
      ? []
      : [{ position: { x, y: 0.2, z }, radius: 0.72 }];

    drive(pair, { x, y: 0.2, z }, points, `walk frame ${frame}`);

    if (frame % 41 === 0) {
      pair.live.clear();
      pair.reference.clear();
      assertIdentical(pair.live, pair.reference, `clear at frame ${frame}`);
    }
  }
});
