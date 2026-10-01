import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { computeFootprint } from '../src/world/structureFootprint.js';

const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const covered = (rects, x, z) => rects.some(r => Math.abs(x - r.x) <= r.width / 2 && Math.abs(z - r.z) <= r.depth / 2);

test('an L-shaped ground floor is covered without filling its inside corner', () => {
  // 10x4 wing along X plus a 4x6 wing along Z, both 3 tall.
  const geometry = mergeGeometries([box(10, 3, 4, 5, 1.5, 2), box(4, 3, 6, 2, 1.5, 7)]);
  const { rectangles } = computeFootprint(geometry.attributes.position.array, geometry.index.array, { bandHeight: 2.5, cell: 0.5 });
  assert.ok(covered(rectangles, 8, 2), 'the long wing is solid');
  assert.ok(covered(rectangles, 2, 8), 'the short wing is solid');
  assert.ok(!covered(rectangles, 8, 8), 'the inside corner stays open');
  assert.ok(rectangles.length <= 4, `few colliders, got ${rectangles.length}`);
});

test('a roof overhang above the ground floor band is not part of the footprint', () => {
  const geometry = mergeGeometries([box(6, 3, 6, 0, 1.5, 0), box(12, 1, 12, 0, 6, 0)]);
  const { rectangles, maxY } = computeFootprint(geometry.attributes.position.array, geometry.index.array, { bandHeight: 2.5, cell: 0.5 });
  assert.equal(maxY, 6.5);
  assert.ok(covered(rectangles, 2.5, 2.5));
  assert.ok(!covered(rectangles, 5, 5), 'the space under the eaves stays walkable');
});

test('hollow walls are filled so the interior is solid', () => {
  const walls = mergeGeometries([
    box(8, 3, 0.3, 0, 1.5, -4), box(8, 3, 0.3, 0, 1.5, 4), box(0.3, 3, 8, -4, 1.5, 0), box(0.3, 3, 8, 4, 1.5, 0),
  ]);
  const { rectangles } = computeFootprint(walls.attributes.position.array, walls.index.array, { bandHeight: 2.5, cell: 0.5 });
  assert.ok(covered(rectangles, 0, 0), 'the enclosed room is filled');
});

test('diagonal walls cover only the cells they cross, not their bounding squares', () => {
  // The 8x8 room turned 45 degrees: a diamond reaching ~5.8 along each axis.
  const walls = mergeGeometries([
    box(8, 3, 0.3, 0, 1.5, -4), box(8, 3, 0.3, 0, 1.5, 4), box(0.3, 3, 8, -4, 1.5, 0), box(0.3, 3, 8, 4, 1.5, 0),
  ]).rotateY(Math.PI / 4);
  const { rectangles } = computeFootprint(walls.attributes.position.array, walls.index.array, { bandHeight: 2.5, cell: 0.5 });
  assert.ok(covered(rectangles, 0, 0), 'the diamond room is filled');
  assert.ok(covered(rectangles, 2.8, 2.8), 'a point on a wall is solid');
  for (const [x, z] of [[4, 4], [-4, 4], [4, -4], [-4, -4]]) {
    assert.ok(!covered(rectangles, x, z), `the corner (${x}, ${z}) outside the walls stays open`);
  }
});
