import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptLandscapeRecords } from '../src/world/ExpandedLandscape.js';
import { coastX } from '../src/world/CoastField.js';

test('expanded landscape trees yield the coastal jungle canopy footprint', () => {
  const sea = { enabled: true, shoreX: 1000, level: -24, depth: 95 };
  const region = { zStart: 250, zEnd: 430, inlandStart: 140, inlandEnd: 270 };
  const z = 340;
  const insideX = coastX(z, sea) - 205;
  const outsideX = coastX(z, sea) - 360;
  const terrain = {
    config: {
      water: { sea },
      biomes: { coastalJungle: { enabled: true, region, ecology: { edgeFade: 18, suppressWorldTrees: true } } },
    },
    bounds: { min: { x: 0, z: 0 }, max: { x: 0, z: 0 } },
    sampleHeight: () => 0,
  };
  const expansion = {
    original: { sampleHeight: () => 0 },
    river: null,
    alpine: null,
    paths: { sample: () => 1 },
  };
  const trees = [
    [insideX, 0, z, 0, 1, 0],
    [outsideX, 0, z, 0, 1, 0],
  ];
  const result = adaptLandscapeRecords(trees, { stones: [], lanterns: [] }, expansion, terrain);
  assert.equal(result.trees.length, 1);
  assert.equal(result.trees[0][0], outsideX);
});
