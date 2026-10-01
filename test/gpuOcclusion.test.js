import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Box3, BoxGeometry, InstancedBufferGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial,
  Object3D, PerspectiveCamera, Vector3, WebGPUCoordinateSystem,
} from 'three';
import { GpuOcclusion } from '../src/rendering/GpuOcclusion.js';
import { isSolidOccluder, occlusionDrawRange, projectOcclusionBounds } from '../src/rendering/occlusionBounds.js';

test('projected bounds round outwards and preserve near-plane intersections', () => {
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const matrix = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const bounds = new Box3(new Vector3(-1, -1, -6), new Vector3(1, 1, -4));
  const rect = projectOcclusionBounds(bounds, matrix, 256, 256);
  assert.ok(rect.minX < 73 && rect.maxX > 183);
  assert.equal(rect.minX, rect.minY);
  assert.ok(rect.depth > 0 && rect.depth < 1);
  bounds.max.z = -0.05;
  assert.equal(projectOcclusionBounds(bounds, matrix, 256, 256), null);
  bounds.max.z = 1;
  assert.equal(projectOcclusionBounds(bounds, matrix, 256, 256), null);
});

test('occlusion respects groups, draw ranges, and instance counts', () => {
  const geometry = new BoxGeometry();
  const material = new MeshBasicMaterial();
  const mesh = new Mesh(geometry, material);
  geometry.setDrawRange(3, 12);
  assert.deepEqual(occlusionDrawRange(mesh, material, { start: 6, count: 6 }), { first: 6, count: 6, instances: 1 });
  const instanced = new InstancedBufferGeometry().copy(geometry);
  instanced.instanceCount = 1234;
  mesh.geometry = instanced;
  assert.equal(occlusionDrawRange(mesh, material).instances, 1234);
  instanced.instanceCount = 0;
  assert.equal(occlusionDrawRange(mesh, material), null);
  mesh.geometry = geometry;
  material.wireframe = true;
  assert.equal(occlusionDrawRange(mesh, material), null);
  geometry.dispose(); instanced.dispose(); material.dispose();
});

test('foliage cutouts, transparency, deformation and clipped surfaces cannot fill occluder depth', () => {
  const geometry = new BoxGeometry();
  const material = new MeshBasicMaterial();
  const mesh = new Mesh(geometry, material);
  assert.equal(isSolidOccluder(mesh), true);
  for (const [key, value] of Object.entries({ transparent: true, alphaTest: 0.5, alphaHash: true,
    opacity: 0.5, positionNode: {}, opacityNode: {}, displacementMap: {}, clippingPlanes: [{}] })) {
    const previous = material[key];
    material[key] = value;
    assert.equal(isSolidOccluder(mesh), false, key);
    material[key] = previous;
  }
  mesh.userData.occlusionOccluder = false;
  assert.equal(isSolidOccluder(mesh), false);
  geometry.dispose(); material.dispose();
});

test('shared geometry gets per-object indirect draws only in the main view', () => {
  const geometry = new BoxGeometry();
  const a = new Mesh(geometry);
  const b = new Mesh(geometry);
  const scene = {};
  const camera = {};
  const calls = [];
  const backend = { draw: (object) => calls.push(object.geometry.indirect) };
  const originalDraw = backend.draw;
  const culling = new GpuOcclusion({ renderer: { backend }, scene, camera });
  const hidden = { indirect: { name: 'hidden' } };
  const visible = { indirect: { name: 'visible' } };
  culling.active.set(a, new Map([[null, hidden]]));
  culling.active.set(b, new Map([[null, visible]]));
  culling.render(() => {
    backend.draw({ object: a, geometry, scene, camera, group: null });
    backend.draw({ object: a, geometry, scene, camera: {}, group: null }); // shadow/reflection
    backend.draw({ object: b, geometry, scene, camera, group: null });
    backend.draw({ object: b, geometry, scene: {}, camera, group: null }); // depth pass
  });
  assert.deepEqual(calls, [hidden.indirect, null, visible.indirect, null]);
  assert.equal(geometry.indirect, null);
  assert.equal(backend.draw, originalDraw);
  assert.throws(() => culling.render(() => { throw new Error('draw failure'); }), /draw failure/);
  assert.equal(backend.draw, originalDraw);
  geometry.dispose(); a.material.dispose(); b.material.dispose();
});

test('unsupported backends and disabled occlusion leave rendering untouched', () => {
  const culling = new GpuOcclusion({ renderer: { backend: {} } });
  culling.prepare();
  assert.equal(culling.stats.supported, false);
  let drawn = false;
  culling.render(() => { drawn = true; });
  assert.equal(drawn, true);
  culling.dispose();
});

test('open-view backoff uses ordinary draws instead of stale visibility', () => {
  const culling = new GpuOcclusion({ renderer: { backend: {} } });
  // Exercise the retained algorithm independently of native GPU resources.
  culling.enabled = true;
  culling.active.set({}, new Map());
  culling.cooldown = 2;
  culling.stats.culledTriangles = 500;
  culling.prepare();
  assert.equal(culling.cooldown, 1);
  assert.equal(culling.active.size, 0);
  assert.equal(culling.stats.culledTriangles, 0);
  culling.enabled = false;
  culling.prepare();
  assert.equal(culling.active.size, 0);
  culling.dispose();
});

test('verified private occlusion bridge is enabled on the pinned r186 build', () => {
  const culling = new GpuOcclusion({ renderer: { backend: { isWebGPUBackend: true } } });
  assert.equal(culling.enabled, true);
  culling.prepare();
  assert.equal(culling.stats.supported, false, 'fixture has no native WebGPU device');
  culling.dispose();
});

test('empty candidate lists enter the existing probe cooldown', () => {
  const culling = new GpuOcclusion({ renderer: { backend: {} } }, { probeInterval: 30 });
  culling.enabled = true;
  culling.stats.occluders = 0;
  culling.backoffIfEmpty();
  assert.equal(culling.cooldown, 29);
  assert.equal(culling.active.size, 0);
  culling.prepare();
  assert.equal(culling.cooldown, 28);
  culling.dispose();
});

test('occlusion defaults keep the depth prepass cheap and demand real savings', () => {
  const culling = new GpuOcclusion({ renderer: { backend: {} } });
  assert.equal(culling.settings.resolutionScale, 0.5, 'the depth prepass runs below native resolution');
  assert.ok(culling.settings.minSavedTrianglesPerMs > 0, 'an effectiveness floor is enforced');

  const tuned = new GpuOcclusion({ renderer: { backend: {} } },
    { resolutionScale: 1, minSavedTrianglesPerMs: 0 });
  assert.equal(tuned.settings.resolutionScale, 1);
  assert.equal(tuned.settings.minSavedTrianglesPerMs, 0);
  culling.dispose();
  tuned.dispose();
});

test('instance bounds are cached until geometry, transforms, or count change', () => {
  const culling = new GpuOcclusion({ renderer: { backend: {} } });
  const geometry = new BoxGeometry(2, 2, 2);
  const material = new MeshBasicMaterial();
  const mesh = new InstancedMesh(geometry, material, 2);
  const dummy = new Object3D();
  dummy.position.set(0, 0, 0);
  dummy.updateMatrix();
  mesh.setMatrixAt(0, dummy.matrix);
  dummy.position.set(40, 0, 0);
  dummy.updateMatrix();
  mesh.setMatrixAt(1, dummy.matrix);
  mesh.count = 2;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.updateMatrixWorld();
  const wide = culling.occlusionBounds(mesh).clone();
  mesh.count = 1;
  const narrow = culling.occlusionBounds(mesh);
  assert.ok(wide.max.x > narrow.max.x + 10);
  geometry.dispose();
  material.dispose();
  culling.dispose();
});

