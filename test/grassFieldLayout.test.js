import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeGrassGrid,
  selectGrassLod,
  terrainTileKey,
  tileDistanceSquared,
  tileOverlapsTerrain,
} from '../src/grass/GrassFieldLayout.js';

test('grass grid is independently capped and oddified per terrain axis', () => {
  assert.deepEqual(computeGrassGrid({
    terrainSizeX: 240,
    terrainSizeZ: 160,
    tileSize: 25,
    maxDistance: 150,
    painterEnabled: false,
  }), {
    terrainTilesX: 10,
    terrainTilesZ: 7,
    gridSizeX: 11,
    gridSizeZ: 7,
  });
});

test('painter startup covers the full terrain tile dimensions', () => {
  assert.deepEqual(computeGrassGrid({
    terrainSizeX: 240,
    terrainSizeZ: 160,
    tileSize: 25,
    maxDistance: 150,
    painterEnabled: true,
  }), {
    terrainTilesX: 10,
    terrainTilesZ: 7,
    gridSizeX: 11,
    gridSizeZ: 7,
  });
});

test('grass distance is measured from the nearest tile boundary', () => {
  assert.equal(tileDistanceSquared(0, 0, 0, 0, 25), 0);
  assert.equal(tileDistanceSquared(20, 0, 0, 0, 25), 56.25);
  assert.equal(tileDistanceSquared(20, 20, 0, 0, 25), 112.5);
});

test('terrain overlap and absolute terrain tile keys match recovered logic', () => {
  const bounds = { min: { x: -50, z: -25 }, max: { x: 50, z: 75 } };
  assert.equal(tileOverlapsTerrain(-62.4, 0, 25, bounds), true);
  assert.equal(tileOverlapsTerrain(-62.5, 0, 25, bounds), false);
  assert.equal(terrainTileKey(-25, 0, 25, bounds), '1,1');
});

test('LOD thresholds use strict squared comparisons', () => {
  const lod = {
    high: { distance: 0.3 },
    medium: { distance: 0.5 },
    low: { distance: 0.9 },
    veryLow: { distance: 1 },
  };
  assert.equal(selectGrassLod((42 - 0.001) ** 2, 140, lod), 'high');
  assert.equal(selectGrassLod(42 ** 2, 140, lod), 'medium');
  assert.equal(selectGrassLod(70 ** 2, 140, lod), 'low');
  assert.equal(selectGrassLod(126 ** 2, 140, lod), 'veryLow');
});
