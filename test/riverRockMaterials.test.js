import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { RiverDetails } from '../src/water/RiverDetails.js';

test('every river, upland and coastal rock batch retains the source PBR textures', () => {
  const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), normalMap: new THREE.Texture(),
    roughnessMap: new THREE.Texture(), aoMap: new THREE.Texture(), color: '#a9aaa3', roughness: 0.86 });
  material.normalScale.set(0.4, 0.4);
  const sources = Array.from({ length: 4 }, () => new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), material));
  const scene = new THREE.Scene();
  const river = { samples: [], sample: () => null };
  const terrain = { config: { water: { sea: { enabled: false } } }, sampleHeight: () => 0 };
  const details = new RiverDetails(scene, river, terrain, sources);
  try {
    assert.equal(details.meshes.length, 4);
    assert.ok(details.meshes.every(mesh => mesh.count > 0));
    for (const mesh of details.meshes) {
      for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap']) {
        assert.equal(mesh.material[key], material[key], key);
      }
      assert.deepEqual(mesh.material.normalScale, material.normalScale);
      assert.equal(mesh.material.color.getHex(), material.color.getHex());
      assert.ok(mesh.material.colorNode?.isNode);
      assert.ok(mesh.material.roughnessNode?.isNode);
    }
    assert.equal(new Set(details.meshes.map(mesh => mesh.material)).size, 1);
  } finally {
    details.dispose();
    for (const source of sources) source.geometry.dispose();
    for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap']) material[key].dispose();
    material.dispose();
  }
});
