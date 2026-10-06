import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCoastalJungleConfig } from '../src/config/validateCoastalJungleConfig.js';

function validConfig() {
  return {
    biomes: {
      coastalJungle: {
        enabled: true,
        asset: 'Assets/terrain/coastal-jungle/scenes/coastal_jungle_v2_reference.glb',
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
        region: { zStart: 250, zEnd: 430, inlandStart: 140, inlandEnd: 270, origin: [846, 312], yaw: Math.PI },
        ecology: { edgeFade: 12, baseVegetationScale: 0 },
        scatter: {
          seed: 941,
          extent: 128,
          chunkSize: 16,
          grassPerChunk: 540,
          groundcoverPerChunk: 100,
          undergrowthPerChunk: 7,
          plantExtent: 22,
          pathClearance: 0.5,
        },
        render: {
          lodHysteresis: 0.06,
          chunkSize: 16,
          grassDenseDistance: 14,
          grassDistance: 34,
          grassFarDensity: 0.2,
          groundcoverDistance: 28,
          undergrowthDistance: 72,
          treeDistance: 180,
          cameraMoveThreshold: 0.2,
          cameraRotationThreshold: 0.0038,
          cameraTurnMarginDegrees: 12,
        },
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
          { maxDistance: 180, shadows: name !== 'performance', density: { grass: 1, tree: 1 } },
        ])),
      },
    },
  };
}

test('coastal jungle validator accepts the v2 runtime contract', () => {
  const config = validConfig();
  assert.equal(validateCoastalJungleConfig(config), config);
});

test('coastal jungle palette accepts optional kind tints and rejects malformed colors', () => {
  const config = validConfig();
  config.biomes.coastalJungle.material.kindTint = { grass: '#b8c6a0', fern: '#d4ddbf' };
  assert.equal(validateCoastalJungleConfig(config), config);
  for (const value of [null, [], { grass: 'lime-ish' }, { grass: 123 }]) {
    config.biomes.coastalJungle.material.kindTint = value;
    assert.throws(() => validateCoastalJungleConfig(config), /kindTint/);
  }
});

test('coastal jungle validator rejects collapsed regions', () => {
  const config = validConfig();
  config.biomes.coastalJungle.region.zEnd = config.biomes.coastalJungle.region.zStart;
  assert.throws(() => validateCoastalJungleConfig(config), /non-zero Z range/);
});

test('coastal jungle validator requires where the authored scene lands', () => {
  const config = validConfig();
  delete config.biomes.coastalJungle.region.origin;
  assert.throws(() => validateCoastalJungleConfig(config), /region\.origin/);

  config.biomes.coastalJungle.region.origin = [846, 'north'];
  assert.throws(() => validateCoastalJungleConfig(config), /region\.origin/);

  config.biomes.coastalJungle.region.origin = [846, 312];
  config.biomes.coastalJungle.region.yaw = 'south';
  assert.throws(() => validateCoastalJungleConfig(config), /region\.yaw/);
});

test('coastal jungle validator rejects a degenerate floor scatter', () => {
  const config = validConfig();
  config.biomes.coastalJungle.scatter.chunkSize = 0;
  config.biomes.coastalJungle.scatter.grassPerChunk = 2.5;
  assert.throws(() => validateCoastalJungleConfig(config), /scatter\.chunkSize/);
  assert.throws(() => validateCoastalJungleConfig(config), /scatter\.grassPerChunk/);
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

test('coastal jungle validator rejects invalid v2 visibility settings', () => {
  const config = validConfig();
  config.biomes.coastalJungle.render.grassDenseDistance = 35;
  config.biomes.coastalJungle.render.grassDistance = 34;
  assert.throws(() => validateCoastalJungleConfig(config), /grassDenseDistance must not exceed/);

  config.biomes.coastalJungle.render.grassDenseDistance = 14;
  config.biomes.coastalJungle.render.cameraRotationThreshold = 2;
  assert.throws(() => validateCoastalJungleConfig(config), /cameraRotationThreshold/);

  config.biomes.coastalJungle.render.cameraRotationThreshold = 0.0038;
  config.biomes.coastalJungle.render.cameraTurnMarginDegrees = 1;
  assert.throws(() => validateCoastalJungleConfig(config), /must cover cameraRotationThreshold/);
});
