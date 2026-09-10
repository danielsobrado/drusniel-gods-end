import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyntheticCatalog } from '../src/biome/BiomeAssets.js';
import {
  ASSET_LIMITS, FAR_VIEWS, MAX_HULL_VERTICES, MAX_MAIN_BATCHES, MAX_SHADOW_BATCHES,
  pendingProvenance, validateCatalog, validateProvenance,
} from '../src/biome/BiomeCatalog.js';
import { reduceConvexPoints } from '../src/biome/convexHull.js';
import { BiomeLod } from '../src/biome/BiomeLod.js';

test('synthetic catalog stays inside triangle, atlas and hull limits', () => {
  const catalog = createSyntheticCatalog();
  assert.deepEqual(validateCatalog(catalog), []);
  assert.equal(catalog.cactus.far.views, FAR_VIEWS);
  assert.equal(catalog.cactus.far.viewsReady.length, 8);
  assert.ok(catalog.cactus.hull.length / 3 <= MAX_HULL_VERTICES);
  assert.ok(ASSET_LIMITS.cactus.near >= 2400);
});

test('provenance records internal authorship and rejects invented credits', () => {
  const manifest = pendingProvenance();
  assert.deepEqual(validateProvenance(manifest), []);
  assert.equal(manifest.assetsPending, true);
  assert.match(manifest.license, /original/);
  assert.deepEqual(validateProvenance({ ...manifest, invented: true }),
    ['provenance must not invent third-party attribution']);
});

test('convex reduction never exceeds 32 vertices', () => {
  const points = new Float32Array(300);
  for (let i = 0; i < 100; i++) {
    points[i * 3] = i;
    points[i * 3 + 1] = i % 7;
    points[i * 3 + 2] = -i;
  }
  const hull = reduceConvexPoints(points, 32);
  assert.ok(hull.length / 3 <= 32);
  assert.ok(hull.length / 3 >= 8);
});

test('complementary LOD bands overlap and rocks keep mid geometry', () => {
  const lod = new BiomeLod(8);
  const origins = new Float32Array([0, 0, 0, 20, 0, 0, 60, 0, 0]);
  const camera = { x: 0, z: 0 };
  lod.partition(origins, 3, camera, 18, 24, 55, 65);
  assert.equal(lod.nearCount, 2);
  assert.ok(lod.midCount >= 1);
  assert.ok(lod.farCount >= 1);
  lod.partition(origins, 3, camera, 18, 24, 55, 65, { rocks: true });
  assert.equal(lod.farCount, 0);
  assert.ok(lod.midCount >= 1);
});

test('batch budgets stay at 13 main and 3 shadow', () => {
  assert.ok(MAX_MAIN_BATCHES <= 13);
  assert.ok(MAX_SHADOW_BATCHES <= 3);
});
