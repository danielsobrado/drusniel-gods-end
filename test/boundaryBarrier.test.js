import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BoundaryBarrier } from '../src/world/BoundaryBarrier.js';
import { createBoundaryGeometry } from '../src/world/boundaryGeometry.js';
import { createBarrierNoise } from '../src/world/BoundaryBarrierMaterial.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

const worldBounds = [
  { position: [10, 0, 0], size: [1, 100, 24] },
  { position: [0, 0, 12], size: [24, 100, 1] },
  { position: [0, 0, -12], size: [24, 100, 1] },
  { position: [-10, 0, 0], size: [1, 100, 24] },
];
const sampler = {
  ready: true,
  bounds: new THREE.Box3(new THREE.Vector3(-20, -10, -20), new THREE.Vector3(20, 20, 20)),
  sampleHeight: (x, z) => x * 0.1 + z * 0.05,
};
const config = { collisions: { worldBounds }, boundaryBarrier: { enabled: true } };

test('the shipped collider layout produces a closed barrier despite unequal wall extents', async () => {
  const shipped = await loadMergedConfig();
  const geometry = createBoundaryGeometry(shipped.collisions.worldBounds, sampler, shipped.boundaryBarrier);
  try {
    assert.equal(geometry.boundingBox.min.x, -414.5);
    assert.equal(geometry.boundingBox.max.x, 383.5);
    assert.equal(geometry.boundingBox.min.z, -417.5);
    assert.equal(geometry.boundingBox.max.z, 408.5);
  } finally { geometry.dispose(); }
});

test('barrier closes on the inside collider faces and follows sloping terrain', () => {
  const geometry = createBoundaryGeometry(worldBounds, sampler, { height: 12 });
  try {
    const p = geometry.attributes.position;
    const uv = geometry.attributes.uv;
    for (let i = 0; i < p.count; i += 2) {
      const x = p.getX(i), z = p.getZ(i);
      assert.ok(Math.abs(x) === 9.5 || Math.abs(z) === 11.5);
      assert.ok(Math.abs(x) <= 9.5 && Math.abs(z) <= 11.5);
      assert.ok(Math.abs(p.getY(i) - (sampler.sampleHeight(x, z) - 0.75)) < 1e-5);
      assert.ok(Math.abs(p.getY(i + 1) - (sampler.sampleHeight(x, z) + 12)) < 1e-5);
      if (i > 0) assert.ok(uv.getX(i) >= uv.getX(i - 2));
    }
    assert.equal(p.getX(0), p.getX(p.count - 2));
    assert.equal(p.getZ(0), p.getZ(p.count - 2));
    assert.equal(p.getY(0), p.getY(p.count - 2));
    assert.ok(geometry.index.count > 0);
    assert.ok(Number.isFinite(geometry.boundingSphere.radius));
  } finally { geometry.dispose(); }
});

test('invalid bounds and nonfinite terrain samples cannot generate a broken barrier', () => {
  for (const bounds of [[], worldBounds.slice(1), worldBounds.map(r => ({ ...r, size: [-1, 2, 3] }))]) {
    assert.throws(() => createBoundaryGeometry(bounds, sampler, { height: 12 }));
  }
  assert.throws(() => createBoundaryGeometry(worldBounds, { ...sampler, ready: false }, { height: 12 }));
  assert.throws(() => createBoundaryGeometry(worldBounds, { ...sampler, sampleHeight: () => NaN }, { height: 12 }));
  assert.throws(() => createBoundaryGeometry(worldBounds, sampler, { height: -1 }));
});

test('seeded noise repeats without a visible edge discontinuity', () => {
  const a = createBarrierNoise(), b = createBarrierNoise();
  try {
    assert.deepEqual(a.image.data, b.image.data);
    assert.equal(a.wrapS, THREE.RepeatWrapping);
    assert.equal(a.wrapT, THREE.RepeatWrapping);
    const { data, width, height } = a.image;
    for (let y = 0; y < height; y++) assert.equal(data[y * width * 4], data[(y * width + width - 1) * 4]);
    for (let x = 0; x < width; x++) assert.equal(data[x * 4], data[((height - 1) * width + x) * 4]);
    assert.ok(new Set(data).size > 40);
  } finally { a.dispose(); b.dispose(); }
});

function fixture(settings = config, terrainSampler = sampler) {
  const scene = new THREE.Scene();
  const terrainRoot = new THREE.Group();
  const fence = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  fence.name = 'fence6_Material_0042';
  terrainRoot.add(fence);
  scene.add(terrainRoot);
  const barrier = new BoundaryBarrier({ scene, terrainRoot, terrainSampler, config: settings });
  return { scene, fence, barrier };
}

test('successful initialization replaces the fence and releases only owned resources', () => {
  const { scene, fence, barrier } = fixture();
  barrier.init();
  assert.equal(fence.visible, false);
  assert.equal(barrier.mesh.parent, scene);
  assert.equal(barrier.mesh.castShadow, false);
  assert.equal(barrier.material.transparent, true);
  assert.equal(barrier.material.depthWrite, false);
  let released = 0, originalReleased = 0;
  for (const resource of [barrier.mesh.geometry, barrier.material, barrier.noise]) {
    resource.addEventListener('dispose', () => released++);
  }
  fence.geometry.addEventListener('dispose', () => originalReleased++);
  const mesh = barrier.mesh;
  barrier.init();
  assert.equal(barrier.mesh, mesh, 'init is idempotent');
  barrier.update(0.5, new THREE.Vector3(9, 2, 3));
  assert.equal(barrier.uniforms.clock.value, 0.5);
  assert.equal(barrier.uniforms.playerPosition.value.x, 9);
  barrier.setEnabled(false);
  assert.equal(fence.visible, true);
  assert.equal(mesh.visible, false);
  barrier.setEnabled(true);
  assert.equal(fence.visible, false);
  barrier.dispose();
  barrier.dispose();
  barrier.update(0.1, new THREE.Vector3());
  assert.equal(mesh.parent, null);
  assert.equal(fence.visible, true);
  assert.equal(released, 3);
  assert.equal(originalReleased, 0);
});

test('disabled or failed initialization leaves the authored fence visible', () => {
  for (const options of [
    [{ ...config, boundaryBarrier: { enabled: false } }, sampler],
    [config, { ...sampler, sampleHeight: () => NaN }],
    [{ ...config, boundaryBarrier: { enabled: true, opacity: NaN } }, sampler],
  ]) {
    const { fence, barrier } = fixture(...options);
    barrier.init();
    assert.equal(fence.visible, true);
    assert.equal(barrier.mesh, null);
    barrier.dispose();
  }
});

test('cleanup preserves an originally hidden fence and supports renderer reconstruction', () => {
  const { fence, barrier } = fixture();
  fence.visible = false;
  barrier.init();
  barrier.dispose();
  assert.equal(fence.visible, false);
  const recovered = fixture();
  recovered.barrier.init();
  assert.ok(recovered.barrier.mesh);
  recovered.barrier.dispose();
});
