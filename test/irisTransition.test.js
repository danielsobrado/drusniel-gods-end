import assert from 'node:assert/strict';
import test from 'node:test';
import { IrisTransition } from '../src/ui/IrisTransition.js';

function fixture(t, reducedMotion = false) {
  const frames = new Map();
  let frameId = 0;
  let now = performance.now();
  const originals = Object.fromEntries(['document', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, {
    document: { createElement: () => ({ style: { setProperty() {} }, setAttribute() {}, remove() {} }) },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    matchMedia: () => ({ matches: reducedMotion }),
  });
  const iris = new IrisTransition({ appendChild() {} });
  t.after(() => {
    iris.dispose();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const finishFrames = async () => {
    for (let i = 0; i < 10; i++) {
      now += 1000;
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback(now);
      await Promise.resolve();
    }
  };
  return { iris, frames, finishFrames };
}

test('rapid preset and shape selections both apply, keeping the latest preset', async t => {
  const { iris, finishFrames } = fixture(t);
  const applied = [];
  const done = iris.run(() => applied.push('old preset'), 'preset');
  iris.run(() => applied.push('shape'), 'shape');
  iris.run(() => applied.push('new preset'), 'preset');
  await finishFrames(); await done;
  assert.deepEqual(applied, ['new preset', 'shape']);
  assert.ok(iris.radius > 100, 'the screen reopens');
});

test('disposing during a wipe settles callers and prevents queued world mutations', async t => {
  const { iris, frames } = fixture(t);
  let applied = false;
  const done = iris.run(() => { applied = true; });
  iris.dispose();
  await done;
  await iris.run(() => { applied = true; });
  assert.equal(applied, false);
  assert.equal(frames.size, 0);
});

test('reduced-motion changes drain without animation frames', async t => {
  const { iris, frames } = fixture(t, true);
  const applied = [];
  const done = iris.run(() => applied.push('preset'), 'preset');
  iris.run(() => applied.push('shape'), 'shape');
  await done;
  assert.deepEqual(applied, ['preset', 'shape']);
  assert.equal(frames.size, 0);
});
