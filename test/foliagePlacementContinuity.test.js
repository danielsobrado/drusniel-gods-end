import test from 'node:test';
import assert from 'node:assert/strict';
import { placeUnderstoryPlants, DEFAULT_UNDERSTORY } from '../src/foliage/understoryPlacement.js';
import { placeWildGrassClumps, DEFAULT_WILD_GRASS } from '../src/foliage/wildGrassPlacement.js';

for (const [name, place, defaults] of [
  ['understory', placeUnderstoryPlants, DEFAULT_UNDERSTORY],
  ['wild grass', placeWildGrassClumps, DEFAULT_WILD_GRASS],
]) {
  test(`${name} preserves plants in the overlapping window when crossing cells`, () => {
    const settings = { ...defaults, radius: 36, cellSize: 12, candidatesPerCell: 16 };
    const options = { settings, variantCount: 10, contains: () => true, sampleHeight: () => 2,
      sampleEcology: () => ({ density: 1, growth: 1, moisture: 1, path: 0, understory: 1 }) };
    const origins = [{ x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: -12 }];
    const insideAll = plant => origins.every(origin => Math.hypot(plant.x - origin.x, plant.z - origin.z) < settings.radius);
    const sort = plants => plants.filter(insideAll).sort((a, b) => a.x - b.x || a.z - b.z);
    const expected = sort(place({ ...options, origin: origins[0] }));
    assert.ok(expected.length > 20);
    for (const origin of origins.slice(1)) assert.deepEqual(sort(place({ ...options, origin })), expected);
  });
}
