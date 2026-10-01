import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createTerrainShadowChunks } from '../src/world/TerrainShadowChunks.js';

test('terrain shadow sections preserve every triangle and never appear in the ordinary camera', () => {
  const scene = new THREE.Scene(), geometry = new THREE.PlaneGeometry(400, 400, 40, 40);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardNodeMaterial(), target = new THREE.Mesh(geometry, material);
  target.position.set(3, 8, 6); target.rotation.y = 0.3; target.castShadow = true; scene.add(target);
  const shadow = new THREE.OrthographicCamera(-50, 50, 50, -50, 1, 500), camera = new THREE.PerspectiveCamera();
  const chunks = createTerrainShadowChunks(target, shadow, 100);
  const triangles = array => {
    const result = [];
    for (let i = 0; i < array.length; i += 3) result.push(`${array[i]},${array[i + 1]},${array[i + 2]}`);
    return result.sort();
  };
  assert.deepEqual(triangles(chunks.proxies.flatMap(mesh => Array.from(mesh.geometry.index.array))), triangles(geometry.index.array));
  assert.equal(target.castShadow, false); assert.equal(target.visible, true);
  assert.ok(chunks.proxies.length > 4);
  for (const mesh of chunks.proxies) {
    assert.equal(camera.layers.test(mesh.layers), false); assert.equal(shadow.layers.test(mesh.layers), true);
    assert.equal(mesh.geometry.attributes.position, geometry.attributes.position);
    assert.ok(mesh.matrix.equals(target.matrix));
    const point = new THREE.Vector3();
    for (const index of mesh.geometry.index.array) assert.ok(mesh.geometry.boundingBox.containsPoint(point.fromBufferAttribute(geometry.attributes.position, index)));
  }
  const size = geometry.index.count;
  chunks.setEnabled(false); assert.equal(target.castShadow, true); assert.ok(chunks.proxies.every(mesh => !mesh.visible));
  chunks.setEnabled(true); assert.equal(target.castShadow, false);
  chunks.dispose(); chunks.dispose();
  assert.equal(scene.children.length, 1); assert.equal(shadow.layers.mask, 1);
  assert.equal(target.castShadow, true); assert.equal(geometry.index.count, size);
  geometry.dispose(); material.dispose();
});
