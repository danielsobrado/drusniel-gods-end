import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ZoneIndex } from '../src/world/ZoneIndex.js';

function buildZoneIndex() {
  const root = new THREE.Group();
  const zone = new THREE.Group();
  zone.name = 'RotatedZone';
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  mesh.rotation.y = Math.PI / 4;
  zone.add(mesh);
  root.add(zone);
  root.updateWorldMatrix(true, true);
  return new ZoneIndex(root, { zones: { test: 'RotatedZone' } });
}

test('zone containment is evaluated in mesh-local space', () => {
  const index = buildZoneIndex();
  assert.equal(index.getZone(new THREE.Vector3(0, 0, 0)), 'test');
  assert.equal(index.getZone(new THREE.Vector3(1.3, 0, 1.3)), null);
});
