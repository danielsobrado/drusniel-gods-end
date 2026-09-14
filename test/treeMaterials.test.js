import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { TreeSystem } from '../src/world/TreeSystem.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

async function fixture() {
  const config = await loadMergedConfig();
  config.trees.appearance.retention = 1;
  config.trees.highDistance = 50;
  config.trees.billboardDistance = 200;
  config.trees.billboardHysteresis = 10;
  config.trees.types = [{ high: 'High', low: 'Low', highLeaves: 'Leaves' }];
  const scene = new THREE.Scene(), root = new THREE.Group(), camera = new THREE.PerspectiveCamera();
  const high = new THREE.Group(); high.name = 'High';
  const geometry = new THREE.BoxGeometry();
  const bark = new THREE.MeshStandardMaterial({ color: '#514331', roughness: 0.9 });
  const foliage = new THREE.MeshStandardMaterial({ map: new THREE.DataTexture(new Uint8Array([90, 150, 40, 255]), 1, 1) });
  high.add(new THREE.Mesh(geometry, bark));
  const leaves = new THREE.Mesh(geometry, foliage); leaves.name = 'Leaves'; high.add(leaves);
  const low = new THREE.Mesh(geometry, foliage); low.name = 'Low';
  root.add(high, low); scene.add(root);
  const system = new TreeSystem({ scene, camera, terrainRoot: root, config,
    worldData: [10, 20, 100, 300].map(x => [x, 0, 0, 0, 1, 0]) }).init();
  return { system, camera, bark, foliage };
}

test('tree population shares source materials while retaining independent tint and fades', async () => {
  const { system, camera, bark } = await fixture();
  try {
    const [a, b] = system.trees;
    assert.equal(new Set(system.trees.flatMap(t => t.highMaterials)).size, 2);
    assert.equal(a.highMaterials[0], b.highMaterials[0]);
    assert.equal(a.highMaterials[1], b.highMaterials[1]);
    assert.notEqual(a.appearance, b.appearance);
    assert.notDeepEqual(a.appearance.tint, b.appearance.tint);
    camera.position.x = -40;
    system.update(0.1); system.update(0.4);
    assert.equal(a.appearance.opacity, 1);
    assert.ok(b.appearance.opacity < 1 && b.appearance.opacity > 0);
    assert.equal(a.highMaterials[0].opacity, 1);
    assert.equal(bark.alphaHash, false);
  } finally { system.dispose(); }
});

test('initial tree LOD hides distant geometry before compilation without fading every tree', async () => {
  const { system } = await fixture();
  try {
    assert.deepEqual(system.trees.map(t => t.high.visible), [true, true, false, false]);
    assert.deepEqual(system.trees.map(t => t.billboardOpacity), [0, 0, 1, 0]);
    assert.equal(system.transitioningTrees.size, 0);
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
    for (const tree of system.trees) {
      tree.billboardGroup.getMatrixAt(tree.billboardIndex, matrix);
      matrix.decompose(position, rotation, scale);
      assert.ok(scale.distanceTo(tree.high.scale) < 1e-6, 'billboards retain each tree shape across LOD changes');
    }
  } finally { system.dispose(); }
});

test('shared tree materials are disposed exactly once and source assets remain owned by terrain', async () => {
  const { system, bark, foliage } = await fixture();
  const materials = new Set(system.trees.flatMap(t => t.highMaterials));
  const counts = new Map();
  for (const m of [...materials, bark, foliage]) m.addEventListener('dispose', () => counts.set(m, (counts.get(m) ?? 0) + 1));
  system.dispose(); system.dispose();
  for (const m of materials) assert.equal(counts.get(m), 1);
  assert.equal(counts.get(bark), undefined);
  assert.equal(counts.get(foliage), undefined);
});
