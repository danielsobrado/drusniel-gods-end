import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {
  chooseTerrainLod,
  createTerrainRenderChunks,
} from '../src/world/TerrainRenderChunks.js';

const settings = {
  midDistance: 100,
  farDistance: 220,
  hysteresis: 10,
};

test('terrain LOD selection applies hysteresis across near, mid and far bands', () => {
  assert.equal(chooseTerrainLod(50, -1, settings), 0);
  assert.equal(chooseTerrainLod(105, 0, settings), 0);
  assert.equal(chooseTerrainLod(111, 0, settings), 1);
  assert.equal(chooseTerrainLod(250, 0, settings), 2);
  assert.equal(chooseTerrainLod(95, 1, settings), 1);
  assert.equal(chooseTerrainLod(89, 1, settings), 0);
  assert.equal(chooseTerrainLod(231, 1, settings), 2);
  assert.equal(chooseTerrainLod(215, 2, settings), 2);
  assert.equal(chooseTerrainLod(209, 2, settings), 1);
  assert.equal(chooseTerrainLod(50, 2, settings), 0);
});

test('expanded terrain renders through independently culled LOD chunks while retaining source geometry', () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.PlaneGeometry(400, 400, 40, 40);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardNodeMaterial();
  const target = new THREE.Mesh(geometry, material);
  target.name = 'Terrain';
  scene.add(target);

  const sampler = {
    ready: true,
    bounds: new THREE.Box3(
      new THREE.Vector3(-200, -10, -200),
      new THREE.Vector3(200, 10, 200),
    ),
    sampleHeight: () => 0,
  };
  const config = {
    terrain: {
      expansion: {
        renderChunks: {
          enabled: true,
          cellSize: 100,
          midDistance: 90,
          farDistance: 120,
          hysteresis: 10,
          midStep: 20,
          farStep: 50,
          skirtDepth: 2,
        },
      },
    },
  };
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 20, 0);

  const chunks = createTerrainRenderChunks(scene, target, sampler, config);
  assert.ok(chunks);
  assert.equal(target.visible, false);
  assert.equal(target.userData.skipWarmup, true);
  assert.ok(chunks.stats.chunks >= 16);
  assert.equal(chunks.stats.sourceTriangles, geometry.index.count / 3);
  assert.ok(chunks.stats.midTriangles < chunks.stats.sourceTriangles);
  assert.ok(chunks.stats.farTriangles < chunks.stats.midTriangles);

  assert.equal(chunks.batches.length, 3);
  assert.ok(chunks.batches.every(batch => batch.isBatchedMesh));
  assert.ok(chunks.batches.every(batch => batch.material === material));
  assert.ok(chunks.batches.every(batch => batch.perObjectFrustumCulled === true));

  chunks.update(camera);
  assert.ok(chunks.stats.near > 0);
  assert.ok(chunks.stats.far > 0);
  assert.equal(chunks.stats.near + chunks.stats.mid + chunks.stats.far, chunks.stats.chunks);
  assert.ok(chunks.stats.activeTriangles < chunks.stats.sourceTriangles);

  camera.position.set(2000, 20, 2000);
  chunks.update(camera);
  assert.equal(chunks.stats.far, chunks.stats.chunks);

  camera.position.set(0, -300, 0);
  chunks.update(camera, { underwaterDepth: 5, underwater3dLodDepth: 1 });
  assert.equal(chunks.stats.underwater3d, true);
  assert.equal(chunks.stats.far, chunks.stats.chunks, 'deep water uses actual 3D terrain distance');

  chunks.update(camera, { underwaterDepth: 0.5, underwater3dLodDepth: 1 });
  assert.equal(chunks.stats.underwater3d, false);
  assert.ok(chunks.stats.near > 0, 'near-surface behavior keeps the original horizontal LOD policy');

  chunks.dispose();
  chunks.dispose();
  assert.equal(target.visible, true);
  assert.equal(target.userData.skipWarmup, undefined);
  assert.equal(scene.children.length, 1);
  assert.equal(geometry.index.count / 3, 3200);
  geometry.dispose();
  material.dispose();
});
