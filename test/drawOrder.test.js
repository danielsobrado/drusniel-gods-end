import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DRAW_ORDER,
  nearGrassDrawOrder,
  setOpaqueDrawOrder,
  vegetationStageDrawOrder,
} from '../src/rendering/drawOrder.js';

test('occluders draw ahead of the terrain, nearest bands first', () => {
  const sequence = [
    DRAW_ORDER.props,
    nearGrassDrawOrder('high'), nearGrassDrawOrder('medium'), nearGrassDrawOrder('low'), nearGrassDrawOrder('veryLow'),
    vegetationStageDrawOrder(0), vegetationStageDrawOrder(1), vegetationStageDrawOrder(2), vegetationStageDrawOrder(3),
    DRAW_ORDER.foliage,
    DRAW_ORDER.farGrass,
    0, // terrain and every unlisted opaque object
  ];
  for (let index = 1; index < sequence.length; index += 1) {
    assert.ok(sequence[index - 1] < sequence[index], `step ${index}: ${sequence[index - 1]} < ${sequence[index]}`);
  }
  // Every order stays above the sky dome, which must remain the first draw.
  assert.ok(Math.min(...sequence) > -1000);
});

test('unknown bands and levels stay inside their category', () => {
  assert.equal(nearGrassDrawOrder('nope'), nearGrassDrawOrder('veryLow'));
  assert.equal(vegetationStageDrawOrder(9), vegetationStageDrawOrder(3));
  assert.equal(vegetationStageDrawOrder(-2), vegetationStageDrawOrder(0));
  assert.ok(vegetationStageDrawOrder(3) < DRAW_ORDER.foliage);
});

test('transparent objects keep their own sort order', () => {
  const opaque = { renderOrder: 0, material: { transparent: false } };
  const glass = { renderOrder: 0, material: [{ transparent: false }, { transparent: true }] };
  assert.equal(setOpaqueDrawOrder(opaque, DRAW_ORDER.props), true);
  assert.equal(opaque.renderOrder, DRAW_ORDER.props);
  assert.equal(setOpaqueDrawOrder(glass, DRAW_ORDER.props), false);
  assert.equal(glass.renderOrder, 0);
});
