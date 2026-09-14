import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco from 'draco3dgltf';
import * as THREE from 'three';
import { resolveTreeShape } from '../src/world/TreeSystem.js';
import { WorldPropSystem } from '../src/world/WorldPropSystem.js';

const ioReady = draco.createDecoderModule().then(decoder => new NodeIO()
  .registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': decoder }));
const read = async name => (await ioReady).read(`public/Assets/terrain/fantasy/${name}.glb`);

test('formerly flat stones sample painted UV triangles and retain one shared material', async () => {
  const doc = await read('rocks');
  const original = await (await ioReady).read('public/Assets/terrain/props/free_pack_-_rocks_stylized.glb');
  const meshes = doc.getRoot().listNodes().filter(n => /^SM_Rocks_(10|11)_/.test(n.getName()));
  assert.equal(meshes.length, 2);
  for (const mesh of meshes) {
    const primitive = mesh.getMesh().listPrimitives()[0];
    const uv = primitive.getAttribute('TEXCOORD_0');
    const min = uv.getMin([]), max = uv.getMax([]);
    assert.ok(max[0] - min[0] > 0.7 && max[1] - min[1] > 0.7);
    assert.ok(primitive.getMaterial().getBaseColorTexture());
    const source = original.getRoot().listNodes().find(n => n.getName() === mesh.getName()).getMesh().listPrimitives()[0];
    const position = primitive.getAttribute('POSITION'), originalPosition = source.getAttribute('POSITION');
    for (const bounds of ['getMin', 'getMax']) {
      const actual = position[bounds]([]), expected = originalPosition[bounds]([]);
      for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(actual[axis] - expected[axis]) < 0.02, 'replacement preserves the instance footprint');
    }
  }
  assert.equal(doc.getRoot().listMaterials().length, 1);
});

test('every upgraded tree keeps named foliage, seven roots, billboards and two high-detail draws', async () => {
  for (let type = 1; type <= 9; type++) {
    const doc = await read(`tree${type}`);
    const high = doc.getRoot().listNodes().find(n => n.getName() === `Tree${type}_High`);
    assert.equal(high.getExtras().fantasyRoots, 7);
    assert.ok(doc.getRoot().listNodes().some(n => n.getName() === `Tree${type}_Low`));
    const meshes = [];
    high.traverse(n => { if (n.getMesh()) meshes.push(n); });
    assert.equal(meshes.length, 2);
    const bark = meshes.find(n => n.getMesh().listPrimitives()[0].getMaterial().getAlphaMode() === 'OPAQUE').getMesh().listPrimitives()[0];
    assert.ok(bark.getAttribute('POSITION').getMin([])[1] < 0, 'root tips embed below the trunk base');
    assert.ok(bark.getMaterial().getBaseColorTexture(), 'roots reuse bark texture');
    assert.ok(meshes.some(n => n.getMesh().listPrimitives()[0].getMaterial().getAlphaMode() === 'MASK'));
  }
});

test('tree shape variation is stable and keeps both LOD representations compatible', () => {
  const settings = { enabled: true, width: 0.22, depth: 0.18, height: 0.08 };
  const position = new THREE.Vector3(15, 0, 60);
  assert.deepEqual(resolveTreeShape(1, position, settings), resolveTreeShape(1, position, settings));
  assert.notDeepEqual(resolveTreeShape(1, position, settings), resolveTreeShape(2, position, settings));
  assert.deepEqual(resolveTreeShape(1, position, {}), new THREE.Vector3(1, 1, 1));
  for (let i = 0; i < 100; i++) {
    const shape = resolveTreeShape(i, position, settings);
    assert.ok(shape.x >= 0.78 && shape.x <= 1.22);
    assert.ok(shape.y >= 0.92 && shape.y <= 1.08);
    assert.ok(shape.z >= 0.82 && shape.z <= 1.18);
  }
});

test('three wooden lantern styles share one wood texture and five materials', async () => {
  const doc = await read('lantern');
  assert.ok(doc.getRoot().listNodes().some(n => n.getName() === 'Lantern'));
  for (const name of ['Lantern', 'LanternWoodland', 'LanternRoadside']) {
    const root = doc.getRoot().listNodes().find(n => n.getName() === name);
    assert.ok(root?.getExtras().lanternStyle);
    assert.equal(root.listChildren().length, 5);
  }
  assert.equal(doc.getRoot().listMaterials().length, 5);
  const glass = doc.getRoot().listMaterials().find(m => /Amber/.test(m.getName()));
  assert.ok(glass.getEmissiveFactor()[0] > 0.5);
  assert.equal(doc.getRoot().listTextures().length, 1, 'wood texture shared by all three supports');
});

test('world placements cycle through all three lantern styles with shared materials', () => {
  const scene = new THREE.Scene(), root = new THREE.Group();
  const names = ['Lantern', 'LanternWoodland', 'LanternRoadside'];
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
  for (const name of names) {
    const source = new THREE.Group(); source.name = name;
    source.add(new THREE.Mesh(geometry, material)); root.add(source);
  }
  scene.add(root);
  const system = new WorldPropSystem({ scene, terrainRoot: root,
    config: { props: { lanternSourceNames: names } },
    data: { lanterns: Array.from({ length: 20 }, (_, i) => [i * 10, 0, 0, 0]) },
  }).init();
  try {
    assert.deepEqual(names.map(name => system.instances.filter(o => o.name === name).length), [7, 7, 6]);
    assert.ok(root.children.every(o => !o.visible));
    assert.ok(system.instances.every(o => o.visible && o.children[0].material === material));
    assert.deepEqual(system.instances.map(o => o.position.x), Array.from({ length: 20 }, (_, i) => i * 10));
  } finally { system.dispose(); geometry.dispose(); material.dispose(); }
});
