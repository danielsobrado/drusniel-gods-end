import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCoastalJungleConfig } from '../src/config/validateCoastalJungleConfig.js';

function validConfig() {
  return {
    biomes: {
      coastalJungle: {
        enabled: true,
        asset: 'Assets/terrain/coastal-jungle/scenes/coastal_jungle_reference.glb',
        anisotropy: 8,
        region: { zStart: 250, zEnd: 430, inlandStart: 140, inlandEnd: 270 },
        placement: {
          slopeSampleDistance: 2,
          maxSlope: 0.75,
          routeMaskMax: 0.08,
          routeFloorRevealStart: 0.08,
          routeFloorRevealDepth: 0.08,
          riverClearance: 10,
          boundsPadding: 1,
        },
        collider: {
          tree: { radius: 0.52, height: 7.5 },
        },
        quality: Object.fromEntries(['performance', 'balanced', 'high', 'ultra'].map((name) => [
          name,
          { maxDistance: 300, density: { grass: 0.5, tree: 1 } },
        ])),
      },
    },
  };
}

test('coastal jungle validator accepts the runtime contract', () => {
  const config = validConfig();
  assert.equal(validateCoastalJungleConfig(config), config);
});

test('coastal jungle validator rejects collapsed regions', () => {
  const config = validConfig();
  config.biomes.coastalJungle.region.zEnd = config.biomes.coastalJungle.region.zStart;
  assert.throws(() => validateCoastalJungleConfig(config), /non-zero Z range/);
});

test('coastal jungle validator rejects invalid quality density and distance', () => {
  const config = validConfig();
  config.biomes.coastalJungle.quality.high.maxDistance = 0;
  config.biomes.coastalJungle.quality.high.density.grass = 1.2;
  assert.throws(() => validateCoastalJungleConfig(config), /high\.maxDistance/);
  assert.throws(() => validateCoastalJungleConfig(config), /high\.density\.grass/);
});
