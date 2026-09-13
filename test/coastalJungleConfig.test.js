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
        material: {
          alphaTest: 0.4,
          shadowAlphaTest: 0.48,
          alphaToCoverage: true,
          foliageRoughnessMin: 0.84,
          surfaceRoughnessMin: 0.9,
          ambientLift: 0.035,
          backlight: 0.18,
          haze: {
            enabled: true,
            color: '#91b1b7',
            start: 18,
            end: 85,
            strength: 0.28,
          },
          wind: {
            enabled: true,
            amplitude: 0.035,
            speed: 1.4,
            spatialX: 0.7,
            spatialZ: 0.6,
            turbulence: 0.28,
            flutterRatio: 0.32,
            kindScale: { grass: 1, tree: 0.18 },
          },
        },
        region: { zStart: 250, zEnd: 430, inlandStart: 140, inlandEnd: 270 },
        ecology: { edgeFade: 18, baseVegetationScale: 0.18 },
        render: { lodHysteresis: 0.06 },
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

test('coastal jungle validator rejects degenerate route reveal and ecology settings', () => {
  const config = validConfig();
  config.biomes.coastalJungle.placement.routeFloorRevealStart = 1;
  config.biomes.coastalJungle.ecology.baseVegetationScale = -0.1;
  assert.throws(() => validateCoastalJungleConfig(config), /routeFloorRevealStart/);
  assert.throws(() => validateCoastalJungleConfig(config), /baseVegetationScale/);
});

test('coastal jungle validator rejects invalid material and wind settings', () => {
  const config = validConfig();
  config.biomes.coastalJungle.material.alphaTest = 1.2;
  config.biomes.coastalJungle.material.wind.amplitude = -0.01;
  assert.throws(() => validateCoastalJungleConfig(config), /material\.alphaTest/);
  assert.throws(() => validateCoastalJungleConfig(config), /wind\.amplitude/);
});

test('coastal jungle validator rejects inverted haze ranges', () => {
  const config = validConfig();
  config.biomes.coastalJungle.material.haze.end = 10;
  assert.throws(() => validateCoastalJungleConfig(config), /haze\.end must be greater/);
});
