import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coastalJungleScatterAssets,
  scatterCoastalJungleFloor,
} from '../src/biome/CoastalJungleScatter.js';

const NAMES = [
  'background_tree_01', 'broadleaf_01', 'broadleaf_02', 'broadleaf_03', 'fern_01', 'fern_02',
  'grass_01', 'grass_02', 'grass_03', 'groundcover_01', 'groundcover_02', 'palm_01', 'palm_02',
  'shrub_01', 'tree_01',
];

// The loop from Codex-and-Blender web/forest-world.js, kept verbatim as the oracle.
function originalScatter(config, names) {
  let seed = config.seed;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const choose = prefix => names.filter(key => key.startsWith(prefix + '_'));
  const grass = choose('grass'), cover = choose('groundcover'), understory = [...choose('fern'), ...choose('broadleaf'), ...choose('palm')];
  const placed = [];
  for (let x = -config.extent; x < config.extent; x += config.chunk_size) {
    for (let z = -config.extent; z < config.extent; z += config.chunk_size) {
      for (const [assets, count] of [[grass, config.grass_per_chunk], [cover, config.groundcover_per_chunk], [understory, config.undergrowth_per_chunk]]) {
        for (let i = 0; i < count; i++) {
          const px = x + random() * config.chunk_size, pz = z + random() * config.chunk_size;
          if (Math.abs(px) < config.plant_extent && Math.abs(pz) < config.plant_extent) continue;
          if (Math.abs(px - 1.8 * Math.sin(-pz * .11)) < .5) continue;
          const asset = assets[Math.floor(random() * assets.length)], s = .65 + random() * .65;
          placed.push([asset, px, pz, random() * Math.PI * 2, s]);
        }
      }
    }
  }
  return placed;
}

test('coastal jungle floor scatter replays the original sequence exactly', () => {
  const original = originalScatter({
    seed: 941,
    extent: 48,
    chunk_size: 16,
    grass_per_chunk: 540,
    groundcover_per_chunk: 100,
    undergrowth_per_chunk: 7,
    plant_extent: 22,
  }, NAMES);
  const replayed = [];
  const count = scatterCoastalJungleFloor({
    seed: 941,
    extent: 48,
    chunkSize: 16,
    grassPerChunk: 540,
    groundcoverPerChunk: 100,
    undergrowthPerChunk: 7,
    plantExtent: 22,
    pathClearance: 0.5,
  }, [...NAMES].reverse(), (...plant) => replayed.push(plant));

  assert.ok(original.length > 10000);
  assert.equal(count, original.length);
  assert.deepEqual(replayed, original);
});

test('coastal jungle scatter keeps the hero patch and the trail clear', () => {
  const plants = [];
  scatterCoastalJungleFloor({
    seed: 7,
    extent: 64,
    chunkSize: 16,
    grassPerChunk: 60,
    groundcoverPerChunk: 10,
    undergrowthPerChunk: 2,
    plantExtent: 22,
    pathClearance: 0.5,
  }, NAMES, (asset, x, z) => plants.push({ asset, x, z }));
  assert.ok(plants.length > 0);
  for (const { x, z } of plants) {
    assert.ok(Math.abs(x) >= 22 || Math.abs(z) >= 22);
    assert.ok(Math.abs(x - 1.8 * Math.sin(-z * 0.11)) >= 0.5);
  }
  const kinds = new Set(plants.map(({ asset }) => asset.replace(/_\d+$/, '')));
  assert.deepEqual([...kinds].sort(), ['broadleaf', 'fern', 'grass', 'groundcover', 'palm']);
});

test('coastal jungle scatter chooses among assets in catalog order', () => {
  assert.deepEqual(
    coastalJungleScatterAssets(['palm_02', 'fern_01', 'palm', 'broadleaf_01', 'palm_01', 'fern_01'], ['fern', 'broadleaf', 'palm']),
    ['fern_01', 'broadleaf_01', 'palm_01', 'palm_02'],
  );
  assert.equal(scatterCoastalJungleFloor({ seed: 1, extent: 0, chunkSize: 16 }, NAMES, () => {}), 0);
});
