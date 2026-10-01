import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainBakeFingerprint, TERRAIN_BAKE_VERSION } from '../src/world/terrainBakeFingerprint.js';
import { validateBakedTerrainManifest } from '../src/world/BakedLandscape.js';

const config = {
  terrain: {
    targetMeshName: 'Terrain',
    scale: 1,
    position: [0, 0, 0],
    rotationY: 0,
    heightResolution: 16,
    expansion: {
      enabled: true,
      width: 100,
      depth: 80,
      center: [10, 20],
      baked: { enabled: true, manifest: 'a.json', data: 'a.bin.gz' },
    },
    alpine: { enabled: true, center: [0, -10] },
  },
  water: {
    position: [0, -2, 0],
    sea: { enabled: true, level: -4 },
    river: { enabled: true, points: [[0, 0, 5], [10, 0, 5]] },
    lake: { points: [[0, 0, 10]] },
  },
};

test('terrain bake fingerprint ignores delivery paths but changes with geometry inputs', () => {
  const first = createTerrainBakeFingerprint(config);
  const moved = structuredClone(config);
  moved.terrain.expansion.baked.manifest = 'other.json';
  assert.equal(createTerrainBakeFingerprint(moved), first);

  const renderOnly = structuredClone(config);
  renderOnly.terrain.expansion.renderChunks = { enabled: true, cellSize: 256 };
  assert.equal(createTerrainBakeFingerprint(renderOnly), first);

  const changed = structuredClone(config);
  changed.terrain.expansion.width = 120;
  assert.notEqual(createTerrainBakeFingerprint(changed), first);
});

test('baked terrain manifests require matching version, config and sampler dimensions', () => {
  const fingerprint = createTerrainBakeFingerprint(config);
  const manifest = {
    version: TERRAIN_BAKE_VERSION,
    fingerprint,
    geometry: {
      position: { count: 3 },
      index: { count: 3 },
    },
    sampler: {
      resolution: 16,
      heights: { count: 256 },
      normalMap: { count: 1024 },
    },
  };
  assert.equal(validateBakedTerrainManifest(manifest, config), true);
  assert.equal(validateBakedTerrainManifest({ ...manifest, fingerprint: 'stale' }, config), false);
});
