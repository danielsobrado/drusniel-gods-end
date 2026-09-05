import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig } from '../src/config/loadConfig.js';

// mergeConfig is the single source of merge semantics: the application, the
// config:dump script and the check:docs guard all go through this function, so
// these tests pin the behavior all three depend on.

test('merges nested objects recursively', () => {
  const target = { camera: { fov: 52, near: 0.1 } };
  mergeConfig(target, { camera: { fov: 45 } });
  assert.deepEqual(target, { camera: { fov: 45, near: 0.1 } });
});

test('later scalars override earlier ones', () => {
  const target = { a: 1, b: 'x' };
  mergeConfig(target, { a: 2 });
  assert.deepEqual(target, { a: 2, b: 'x' });
});

test('adds keys that are absent from the target', () => {
  const target = { a: 1 };
  mergeConfig(target, { b: { c: 2 } });
  assert.deepEqual(target, { a: 1, b: { c: 2 } });
});

// This is the semantic that makes the trees.types block in config.yaml dead
// configuration, and the most common reason an edit appears to have no effect.
test('arrays are REPLACED wholesale, not merged element-wise', () => {
  const target = { trees: { types: [{ zone: 'a' }, { zone: 'b' }, { zone: 'c' }] } };
  mergeConfig(target, { trees: { types: [{ zones: ['x'] }] } });
  assert.deepEqual(target.trees.types, [{ zones: ['x'] }]);
});

test('a shorter array fully replaces a longer one', () => {
  const target = { list: [1, 2, 3, 4, 5] };
  mergeConfig(target, { list: [9] });
  assert.deepEqual(target.list, [9]);
});

test('an array replaces an object and vice versa', () => {
  const toArray = { value: { a: 1 } };
  mergeConfig(toArray, { value: [1, 2] });
  assert.deepEqual(toArray.value, [1, 2]);

  const toObject = { value: [1, 2] };
  mergeConfig(toObject, { value: { a: 1 } });
  assert.deepEqual(toObject.value, { a: 1 });
});

test('null overrides rather than merging', () => {
  const target = { a: { b: 1 } };
  mergeConfig(target, { a: null });
  assert.equal(target.a, null);
});

test('null in the target is overwritten by an object', () => {
  const target = { a: null };
  mergeConfig(target, { a: { b: 1 } });
  assert.deepEqual(target.a, { b: 1 });
});

test('mutates and returns the target', () => {
  const target = { a: 1 };
  const returned = mergeConfig(target, { b: 2 });
  assert.equal(returned, target);
});

test('reduce over several sources applies last-wins ordering', () => {
  const sources = [
    { player: { modelOffsetY: -0.2, walkSpeed: 4.2 } },
    { player: { modelOffsetY: -2.2 } },
    { player: { walkSpeed: 2.5 } },
  ];
  const merged = sources.slice(1).reduce((acc, cur) => mergeConfig(acc, cur), sources[0]);
  assert.deepEqual(merged.player, { modelOffsetY: -2.2, walkSpeed: 2.5 });
});
