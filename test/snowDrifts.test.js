import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { MeshStandardMaterial, Scene, Vector3 } from 'three';
import { createSnowDriftPatch, SnowDriftSystem } from '../src/world/SnowDriftSystem.js';
import { validateSnowConfig } from '../src/config/validateSnowConfig.js';

const config = yaml.load(fs.readFileSync(new URL('../public/snow.yaml', import.meta.url), 'utf8'));
const source = { position: new Vector3(0, 175, 0), radius: 1 };
const terrain = (height = () => 175, path = () => 0) => ({
  sampleHeight: height, paths: { sample: path }, contains: (x, z) => Math.abs(x) < 200 && Math.abs(z) < 200,
});

test('drifts have real thickness, buried edges and deterministic terrain-conforming geometry', () => {
  const ground = terrain(x => 175 + x * 0.1);
  const patch = createSnowDriftPatch(source, ground, config);
  assert.ok(patch);
  assert.deepEqual(patch, createSnowDriftPatch(source, ground, config));
  assert.ok(patch.height > 0.2 && patch.height <= config.ground.snow.drifts.maxHeight);
  assert.equal(patch.indices.length / 3, 128);
  const centerIndex = (4 * 9 + 4) * 3;
  assert.ok(patch.positions[centerIndex + 1] > ground.sampleHeight(patch.positions[centerIndex]) + 0.2);
  for (let i = 0; i < 9; i++) {
    for (const vertex of [i, 72 + i, i * 9, i * 9 + 8]) {
      assert.ok(patch.positions[vertex * 3 + 1] < ground.sampleHeight(patch.positions[vertex * 3]));
    }
  }
  assert.ok(patch.positions.every(Number.isFinite));
});

test('drifts reject bare ground, cliffs, terrain edges and trails crossing their shoulders', () => {
  assert.equal(createSnowDriftPatch({ ...source, position: new Vector3(0, 20, 0) }, terrain(() => 20), config), null);
  assert.equal(createSnowDriftPatch(source, terrain(x => 175 + x * 2), config), null);
  assert.equal(createSnowDriftPatch({ ...source, position: new Vector3(199, 175, 0) }, terrain(), config), null);
  assert.equal(createSnowDriftPatch(source, terrain(() => 175, x => Math.abs(x - 2) < 0.7 ? 1 : 0), config), null);
  const off = structuredClone(config);
  off.ground.snow.drifts.enabled = false;
  assert.equal(createSnowDriftPatch(source, terrain(), off), null);
});

test('drift budgets and chunk bounds are finite; disposal preserves the borrowed terrain material', () => {
  const limited = structuredClone(config);
  limited.ground.snow.drifts.maxCount = 2;
  const scene = new Scene(), material = new MeshStandardMaterial();
  let materialDisposed = false;
  material.addEventListener('dispose', () => { materialDisposed = true; });
  const props = [0, 0.1, 12, 24].map(x => ({ position: new Vector3(x, 175, 0), radius: 1 }));
  const drifts = new SnowDriftSystem({ scene, material, terrain: terrain(), config: limited, props });
  assert.equal(drifts.count, 2);
  let disposed = 0;
  for (const mesh of drifts.meshes) {
    assert.equal(mesh.material, material);
    assert.ok(Number.isFinite(mesh.geometry.boundingSphere.radius));
    assert.ok([...mesh.geometry.attributes.normal.array].every(Number.isFinite));
    assert.ok([...mesh.geometry.attributes.normal.array].filter((_, i) => i % 3 === 1).every(y => y > 0));
    mesh.geometry.addEventListener('dispose', () => disposed++);
  }
  const count = drifts.meshes.length;
  drifts.dispose();
  assert.equal(disposed, count);
  assert.equal(scene.children.length, 0);
  assert.equal(materialDisposed, false);
});

test('snow validation rejects unbounded drift geometry', () => {
  for (const [key, value] of [['maxCount', 1.2], ['maxRadius', 100], ['heightScale', -1], ['maxHeight', 10]]) {
    const invalid = structuredClone(config);
    invalid.ground.snow.drifts[key] = value;
    assert.throws(() => validateSnowConfig(invalid), new RegExp(`ground.snow.drifts.${key}`));
  }
});
