import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { TreeSystem } from '../src/world/TreeSystem.js';
import { TreeLeafMaterialFactory } from '../src/world/TreeLeafMaterial.js';
import { createVegetationJobScheduler } from '../src/foliage/vegetationRebuild.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

async function fixture({ cinematic = null } = {}) {
  const config = await loadMergedConfig();
  if (cinematic !== null) config.cinematic.enabled = cinematic;
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

test('successful instanced LOD replacement retires scene traversal but preserves tree reference bounds', async t => {
  const { system, camera } = await fixture();
  // An empty derivative manifest exercises the real full-mesh fallback without
  // fetching textures; initLods still creates the production instanced renderer.
  const previousDocument = globalThis.document;
  globalThis.document = { baseURI: 'http://localhost/' };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ variants: {} }) }));
  const originals = system.trees.map(tree => tree.high);
  const bounds = originals.map(object => new THREE.Box3().setFromObject(object));
  const materials = new Set(originals.flatMap(object => object.children.map(child => child.material)));
  let disposed = 0;
  for (const material of materials) material.addEventListener('dispose', () => disposed++);
  try {
    await system.initLods();
    assert.ok(system.lodRenderer, 'real LOD initialization succeeds');
    assert.ok(originals.every(object => object.parent === null), 'unused trees leave the render traversal');
    assert.equal(system.billboardGroups.length, 0, 'legacy billboard batches are released after LOD takeover');
    assert.ok(system.trees.every(tree => tree.high === null), 'per-tree scene graphs are released after LOD takeover');
    assert.ok(system.trees.every(tree => tree.obstacle && tree.worldScale), 'runtime obstacle and collider metadata survives');
    originals.forEach((object, i) => assert.ok(new THREE.Box3().setFromObject(object).equals(bounds[i]),
      'external references remain unchanged even after TreeSystem releases its clone'));
    assert.equal(disposed, 0, 'shared source geometry and materials remain available to their owners');
    camera.position.set(10, 0, 10); camera.lookAt(10, 0, 0); system.update();
    assert.ok(system.stats.visibleInstances > 0, 'replacement instances remain visible');
  } finally { system.dispose(); }
});


test('cancelled streamed tree staging rolls back legacy state and retries cleanly', async t => {
  const config = await loadMergedConfig();
  config.trees.appearance.retention = 1;
  config.trees.types = [
    { high: 'HighA', low: 'LowA', highLeaves: 'LeavesA' },
    { high: 'HighB', low: 'LowB', highLeaves: 'LeavesB' },
  ];

  const previousDocument = globalThis.document;
  globalThis.document = { baseURI: 'http://localhost/' };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ variants: {} }) }));

  const scene = new THREE.Scene();
  const root = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
  camera.position.set(0, 4, 20);
  camera.lookAt(0, 4, 0);
  const geometry = new THREE.BoxGeometry();
  const bark = new THREE.MeshStandardMaterial();
  const foliageTexture = new THREE.DataTexture(new Uint8Array([90, 150, 40, 255]), 1, 1);
  const foliage = new THREE.MeshStandardMaterial({ map: foliageTexture });

  const addSource = (highName, lowName, leavesName) => {
    const high = new THREE.Group();
    high.name = highName;
    high.add(new THREE.Mesh(geometry, bark));
    const leaves = new THREE.Mesh(geometry, foliage);
    leaves.name = leavesName;
    high.add(leaves);
    const low = new THREE.Mesh(geometry, foliage);
    low.name = lowName;
    root.add(high, low);
  };

  addSource('HighA', 'LowA', 'LeavesA');
  scene.add(root);
  const system = new TreeSystem({
    scene,
    camera,
    terrainRoot: root,
    config,
    worldData: [
      [0, 0, 0, 0, 1, 0],
      [40, 0, 0, 0, 1, 1],
    ],
  }).init();

  try {
    await system.initLods();
    const existingRenderer = system.lodRenderer;
    assert.ok(existingRenderer);
    assert.equal(system.trees.length, 1);

    addSource('HighB', 'LowB', 'LeavesB');
    root.updateWorldMatrix(true, true);

    const scheduler = createVegetationJobScheduler({ budgetMs: 2 });
    system.setScheduler(scheduler, { prepare: async () => {} });
    const controller = new AbortController();
    const pending = system.addStreamedTypes([1], controller.signal);
    for (let spin = 0; spin < 32 && system.streamJobs.size === 0; spin += 1) await Promise.resolve();
    assert.equal(system.streamJobs.size, 1, 'streamed LOD staging was not queued');

    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(system.lodRenderer, existingRenderer, 'existing LOD renderer survives a cancelled stream');
    assert.equal(system.trees.length, 1, 'cancelled streamed trees are removed');
    assert.equal(system.sources[1], null, 'cancelled source registration is rolled back');
    assert.equal(system.billboardGroups.length, 0, 'cancelled legacy billboard batches are released');
    assert.equal(system.createdWorldIndices.has(1), false, 'world record can be retried');

    system.setScheduler(null);
    const retried = await system.addStreamedTypes([1], new AbortController().signal);
    assert.equal(retried.length, 1);
    assert.equal(retried[0].typeIndex, 1);
    assert.equal(retried[0].high, null, 'retry completes the instanced LOD handoff');
    scheduler.dispose();
  } finally {
    system.dispose();
    geometry.dispose();
    bark.dispose();
    foliage.dispose();
    foliageTexture.dispose();
  }
});


test('leaf material preserves source tint outside cinematic overrides', async () => {
  const config = await loadMergedConfig();
  config.cinematic.enabled = false;
  const texture = new THREE.DataTexture(new Uint8Array([120, 180, 70, 255]), 1, 1);
  const source = new THREE.MeshStandardMaterial({
    color: '#78934f',
    map: texture,
    roughness: 0.73,
    metalness: 0.08,
  });
  const factory = new TreeLeafMaterialFactory(config);
  try {
    const material = factory.create(source);
    assert.equal(material.color.getHex(), source.color.getHex());
    assert.equal(material.roughness, source.roughness);
    assert.equal(material.metalness, source.metalness);
    assert.equal(material.map, source.map);
    assert.ok(material.colorNode, 'textured leaves preserve the source color through the explicit color graph');

    const tinted = factory.create(source, new THREE.Color(0.7, 0.8, 0.9));
    assert.ok(tinted.colorNode, 'non-cinematic instanced leaves retain per-tree tint');
    tinted.dispose();
  } finally {
    factory.dispose();
    source.dispose();
    texture.dispose();
  }
});


test('legacy billboards retain per-tree tint outside cinematic mode', async () => {
  const { system } = await fixture({ cinematic: false });
  try {
    const material = system.billboardGroups[0]?.material;
    assert.ok(material?.colorNode, 'legacy billboard color includes the instance tint');
    assert.ok(system.trees[0].highMaterials.some(candidate => candidate.colorNode),
      'near foliage uses the same per-tree tint outside cinematic mode');
  } finally {
    system.dispose();
  }
});


test('leaf material keeps its texture when applying an instance tint', async () => {
  const config = await loadMergedConfig();
  config.cinematic.enabled = false;
  const texture = new THREE.DataTexture(new Uint8Array([80, 140, 45, 255]), 1, 1);
  const source = new THREE.MeshStandardMaterial({ color: '#809060', map: texture });
  const factory = new TreeLeafMaterialFactory(config);
  try {
    const material = factory.create(source, new THREE.Color(0.8, 0.9, 0.7));
    assert.equal(material.map, texture);
    assert.ok(material.colorNode, 'instance tint uses an explicit textured color graph');
  } finally {
    factory.dispose();
    source.dispose();
    texture.dispose();
  }
});
