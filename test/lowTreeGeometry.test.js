import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createLowTreeParts } from '../src/foliage/LowTreeGeometry.js';

function foliageGeometry(cards = 24) {
  const positions = [], indices = [];
  for (let card = 0; card < cards; card += 1) {
    const x = (card % 6) * 2, y = Math.floor(card / 6) * 2;
    const base = positions.length / 3;
    positions.push(
      x - 0.5, y, 0,
      x + 0.5, y, 0,
      x + 0.5, y + 1, 0,
      x - 0.5, y + 1, 0,
    );
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

test('derived low tree geometry drops complete foliage cards without duplicating vertex buffers', () => {
  const geometry = foliageGeometry();
  const material = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
  const originalTriangles = geometry.index.count / 3;
  const derived = createLowTreeParts([{ geometry, material, name: 'Leaves' }], {
    foliageKeepRatio: 0.5,
    grid: [2, 2, 2],
    minComponents: 4,
    maxComponentShare: 0.2,
  });
  const low = derived.parts[0].geometry;
  assert.notEqual(low, geometry);
  assert.equal(low.attributes.position, geometry.attributes.position);
  assert.ok(low.index.count < geometry.index.count);
  assert.equal(low.index.count % 6, 0, 'whole two-triangle cards are retained');
  assert.ok(low.index.count / 3 < originalTriangles);
  derived.dispose();
  geometry.dispose();
  material.dispose();
});

test('opaque tree parts reuse medium geometry unchanged', () => {
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial();
  const derived = createLowTreeParts([{ geometry, material, name: 'Trunk' }]);
  assert.equal(derived.parts[0].geometry, geometry);
  derived.dispose();
  geometry.dispose();
  material.dispose();
});


test('transparent foliage is reduced as cards instead of treated as opaque wood', () => {
  const geometry = foliageGeometry();
  const material = new THREE.MeshStandardMaterial({ transparent: true });
  const derived = createLowTreeParts([{ geometry, material, name: 'BlendLeaves' }], {
    foliageKeepRatio: 0.5,
    grid: [2, 2, 2],
    minComponents: 4,
    maxComponentShare: 0.2,
  });
  assert.ok(derived.parts[0].geometry.index.count < geometry.index.count);
  derived.dispose();
  geometry.dispose();
  material.dispose();
});
