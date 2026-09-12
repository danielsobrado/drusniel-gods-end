import test from 'node:test';
import assert from 'node:assert/strict';
import { ProceduralVegetationField } from '../src/grass/ProceduralVegetationField.js';
import { coastX } from '../src/world/CoastField.js';
import {
  isCoastalJungleRuntimeActive,
  setCoastalJungleRuntimeActive,
} from '../src/biome/CoastalJungleRuntime.js';

function fieldFixture() {
  const sea = { enabled: true, shoreX: 1000, level: -24, depth: 95 };
  const z = 340;
  const x = coastX(z, sea) - 205;
  const config = {
    vegetation: { resolution: 2, growthThreshold: 0.3, distributionCellSize: 1, seed: 1 },
    water: { sea },
    biomes: {
      coastalJungle: {
        enabled: true,
        region: { zStart: 250, zEnd: 430, inlandStart: 140, inlandEnd: 270 },
        ecology: { edgeFade: 18, baseVegetationScale: 0.18 },
      },
    },
  };
  const terrain = {
    bounds: { min: { x: x - 10, z: z - 10 }, max: { x: x + 10, z: z + 10 } },
    size: { x: 20, z: 20 },
  };
  const field = new ProceduralVegetationField(config, terrain);
  for (let index = 0; index < 4; index += 1) {
    const offset = index * 5;
    field.data[offset] = 1;
    field.data[offset + 1] = 1;
    field.data[offset + 2] = 0.5;
    field.data[offset + 3] = 1;
    field.data[offset + 4] = 0;
  }
  field.ready = true;
  return { config, field, x, z };
}

test('coastal jungle ecology activation is runtime-only and fail-open', () => {
  const { config } = fieldFixture();
  assert.equal(isCoastalJungleRuntimeActive(config), false);
  setCoastalJungleRuntimeActive(config, true);
  assert.equal(isCoastalJungleRuntimeActive(config), true);
  setCoastalJungleRuntimeActive(config, false);
  assert.equal(isCoastalJungleRuntimeActive(config), false);
});

test('generic ecology is reduced only after the jungle asset becomes active', () => {
  const { config, field, x, z } = fieldFixture();
  const fallback = field.sampleWorld(x, z);
  assert.equal(fallback.density, 1);
  assert.equal(fallback.growth, 1);
  assert.equal(fallback.understory, 1);

  setCoastalJungleRuntimeActive(config, true);
  try {
    const active = field.sampleWorld(x, z);
    assert.ok(Math.abs(active.density - 0.18) < 1e-6);
    assert.ok(Math.abs(active.growth - 0.18) < 1e-6);
    assert.ok(Math.abs(active.understory - 0.18) < 1e-6);
    assert.equal(active.moisture, 0.5);
    assert.equal(active.path, 0);
  } finally {
    setCoastalJungleRuntimeActive(config, false);
  }
});
