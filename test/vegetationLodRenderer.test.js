import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { VegetationLodRenderer } from '../src/foliage/VegetationLodRenderer.js';
import { validateVegetationLodConfig } from '../src/config/validateVegetationLodConfig.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

test('LOD submissions handle reversals, teleports, missing levels and preserve transformed billboard centers', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  const geometry = new THREE.BoxGeometry(3, 12, 3), material = new THREE.MeshStandardNodeMaterial();
  const full = [{ geometry, material }], atlas = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const capture = { center: [0, 6, 0], width: 4, height: 12, views: 8, tileSize: 128 };
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(17, 4, -23),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, 0.7, -0.1)), new THREE.Vector3(1.3, 2, 0.7));
  const position = new THREE.Vector3().setFromMatrixPosition(matrix);
  const renderer = new VegetationLodRenderer({ scene, config: {}, prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [80, 160, 300], far: 900 }) });
  renderer.addVariant({ key: 'test', full, asset: { levels: [null, full, full], atlas, entry: { capture } },
    records: [{ matrix: new Float32Array(matrix.elements), position, height: 24, fraction: 0,
      sphere: new THREE.Sphere(position, 30) }] });
  const visit = distance => {
    camera.position.copy(position).add(new THREE.Vector3(0, 0, distance)); camera.lookAt(position); camera.updateMatrixWorld();
    return { ...renderer.update(camera) };
  };
  assert.equal(visit(20).full, 1); assert.equal(visit(120).medium, 1); assert.equal(visit(220).low, 1);
  assert.equal(visit(500).billboard, 1);
  const card = scene.children.find(o => o.name === 'test:billboard');
  const actual = new THREE.Matrix4(); card.getMatrixAt(0, actual);
  const expectedCenter = new THREE.Vector3(...capture.center).applyMatrix4(matrix);
  assert.ok(new THREE.Vector3().setFromMatrixPosition(actual).distanceTo(expectedCenter) < 1e-4);
  assert.equal(card.castShadow, false); assert.equal(card.userData.excludeFromReflection, true);
  assert.equal(visit(80).full, 1); assert.equal(renderer.stats.medium, 1);
  const intervals = renderer.chunks[0].draws.slice(0, 2).map(draw => [...draw.interval.array.slice(0, 2)]);
  assert.deepEqual(intervals, [[0, 0.5], [0.5, 1]]);
  assert.equal(visit(20).full, 1); assert.equal(renderer.stats.billboard, 0);
  assert.equal(visit(1000).visibleInstances, 0);
  assert.equal(visit(220).low, 1);
  renderer.chunks[0].templates[2] = null;
  renderer.setQuality('balanced'); assert.equal(visit(220).medium, 1);
  const mesh = scene.children.find(o => o.name === 'test:full');
  assert.equal(mesh.geometry.attributes.position, geometry.attributes.position);
  renderer.dispose(); renderer.dispose(); assert.equal(scene.children.length, 0);
  geometry.dispose(); material.dispose(); atlas.dispose();
});

test('vegetation configuration rejects reversed transitions and cutoffs before handoff', async () => {
  const config = await loadMergedConfig(); const problems = [];
  validateVegetationLodConfig(config, problems); assert.deepEqual(problems, []);
  config.trees.lod.distances = [80, 60, 300]; config.grass.far.distances.high = 40;
  validateVegetationLodConfig(config, problems);
  assert.ok(problems.some(p => p.includes('increasing')));
  assert.ok(problems.some(p => p.includes('near grass range')));
});

test('distant plant movement reuses static buffers without per-record policy or matrix work', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  let visits = 0;
  const renderer = new VegetationLodRenderer({ scene, config: {}, chunkSize: 20, prepareMaterial: () => material.clone(),
    policy: () => { visits++; return { plant: true, centers: [24], blend: 10 / 24, far: 500 }; } });
  const records = Array.from({ length: 2000 }, (_, i) => {
    const position = new THREE.Vector3(i % 10, 0, -100 - Math.floor(i / 10) * 0.01);
    return { position, matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0, sphere: new THREE.Sphere(position, 2) };
  });
  renderer.addVariant({ key: 'grass', kind: 'grass', full: [{ geometry, material }], records,
    asset: { levels: [], atlas, entry: { capture: { center: [0, 1, 0], width: 2, height: 2, views: 8, tileSize: 128 } } } });
  camera.lookAt(0, 0, -100); renderer.update(camera);
  const cards = scene.children.filter(mesh => mesh.name === 'grass:billboard');
  const versions = cards.map(mesh => mesh.geometry.attributes.cardCenter.data.version);
  visits = 0;
  for (let i = 0; i < 20; i++) { camera.position.x += 0.1; renderer.update(camera); }
  assert.ok(visits < 100, `policy visits must scale with chunks, not 2000 stems: ${visits}`);
  assert.deepEqual(cards.map(mesh => mesh.geometry.attributes.cardCenter.data.version), versions);
  assert.ok(cards.every(mesh => mesh.geometry.attributes.cardOrigin.data === mesh.geometry.attributes.cardCenter.data));
  assert.equal(records.some(record => record.inverse), false);
  assert.equal(renderer.stats.full, 0);
  assert.equal(renderer.stats.billboard, 2000);
  renderer.setQuality('performance'); renderer.update(camera);
  assert.ok(cards.every(mesh => mesh.visible));
  renderer.dispose(); assert.equal(scene.children.length, 0);
  geometry.dispose(); material.dispose(); atlas.dispose();
});
