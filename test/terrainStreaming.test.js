import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldPreloadTerrainGroup,
  splitTerrainSources,
  terrainGroupContainsPreloadPosition,
  streamedTreeTypeIndices,
} from '../src/world/terrainStreaming.js';

const config = {
  assets: {
    terrainStreaming: {
      enabled: true,
      groups: {
        alpineTrees: {
          parts: ['trees/tree10', 'trees/tree11'],
          center: [-25, -655],
          radius: 275,
          preloadDistance: 150,
        },
      },
    },
  },
};

test('terrain streaming removes deferred parts from the startup batch', () => {
  const sources = [
    { name: 'landscape', path: 'landscape.glb' },
    { name: 'trees/tree9', path: 'tree9.glb' },
    { name: 'trees/tree10', path: 'tree10.glb' },
    { name: 'trees/tree11', path: 'tree11.glb' },
  ];
  const result = splitTerrainSources(sources, config);
  assert.deepEqual(result.immediate.map(source => source.name), ['landscape', 'trees/tree9']);
  assert.deepEqual(result.deferredGroups[0].sources.map(source => source.name), ['trees/tree10', 'trees/tree11']);
});

test('terrain streaming separates proximity from load state', () => {
  const group = splitTerrainSources([{ name: 'trees/tree10', path: 'tree10.glb' }], config).deferredGroups[0];
  const near = { x: -25, z: -250 };
  assert.equal(terrainGroupContainsPreloadPosition(near, group), true);
  assert.equal(terrainGroupContainsPreloadPosition({ x: 2, z: -5 }, group), false);
  assert.equal(shouldPreloadTerrainGroup(near, group), true);
  group.loading = true;
  assert.equal(shouldPreloadTerrainGroup(near, group), false);
  assert.equal(terrainGroupContainsPreloadPosition(near, group), true);
  group.loading = false;
  group.failed = true;
  assert.equal(shouldPreloadTerrainGroup(near, group), false);
});

test('streamed tree types are derived from terrain part names', () => {
  assert.deepEqual(streamedTreeTypeIndices({
    parts: ['trees/tree10', 'props/rock', 'trees/tree19', 'trees/tree10'],
  }), [9, 18]);
});
