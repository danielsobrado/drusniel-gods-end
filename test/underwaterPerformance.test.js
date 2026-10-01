import test from 'node:test';
import assert from 'node:assert/strict';
import { UnderwaterPerformanceController } from '../src/water/UnderwaterPerformanceController.js';

function renderSystem() {
  return {
    enabled: true,
    calls: [],
    setRenderEnabled(value) {
      this.enabled = Boolean(value);
      this.calls.push(this.enabled);
    },
  };
}

test('underwater performance culls expensive systems with hysteresis and restores them', () => {
  const camera = { position: { x: 0, y: 1, z: 0 } };
  const water = {
    depths: [],
    surfaceLevelAt: () => 0,
    setPerformanceDepth(depth) { this.depths.push(depth); },
  };
  const vegetation = renderSystem();
  const atmosphere = renderSystem();
  const lighting = {
    enabled: true,
    calls: [],
    setShadowRenderEnabled(value) {
      this.enabled = Boolean(value);
      this.calls.push(this.enabled);
    },
  };
  const controller = new UnderwaterPerformanceController({
    camera,
    water,
    cinematicLighting: lighting,
    vegetation: [vegetation],
    atmosphere: [atmosphere],
    config: {
      cinematic: {
        enabled: true,
        water: {
          underwaterPerformance: {
            enabled: true,
            hysteresis: 0.5,
            vegetationCullDepth: 2,
            atmosphereCullDepth: 4,
            shadowCullDepth: 6,
            terrain3dLodDepth: 1,
          },
        },
      },
    },
  });

  controller.update();
  assert.equal(controller.depth, -1);
  assert.equal(vegetation.enabled, true);

  camera.position.y = -2;
  controller.update();
  assert.equal(vegetation.enabled, false);
  assert.equal(atmosphere.enabled, true);
  assert.equal(controller.terrainOptions.underwaterDepth, 2);

  camera.position.y = -1.7;
  controller.update();
  assert.equal(vegetation.enabled, false, 'hysteresis prevents threshold flicker');

  camera.position.y = -1.4;
  controller.update();
  assert.equal(vegetation.enabled, true);

  camera.position.y = -6;
  controller.update();
  assert.equal(vegetation.enabled, false);
  assert.equal(atmosphere.enabled, false);
  assert.equal(lighting.enabled, false);

  controller.dispose();
  assert.equal(vegetation.enabled, true);
  assert.equal(atmosphere.enabled, true);
  assert.equal(lighting.enabled, true);
  assert.equal(water.depths.at(-1), Number.NEGATIVE_INFINITY);
});


test('default underwater suppression drops vegetation just below the surface', () => {
  const camera = { position: { x: 0, y: -0.2, z: 0 } };
  const water = { surfaceLevelAt: () => 0, setPerformanceDepth() {} };
  const vegetation = renderSystem();
  const controller = new UnderwaterPerformanceController({
    camera,
    water,
    vegetation: [vegetation],
    config: { cinematic: { enabled: true, water: { underwaterPerformance: { enabled: true } } } },
  });

  controller.update();
  assert.equal(vegetation.enabled, true, 'a shallow view keeps terrestrial vegetation');

  camera.position.y = -1.6;
  controller.update();
  assert.equal(vegetation.enabled, false, 'vegetation leaves within a stride of the surface');

  camera.position.y = -0.5;
  controller.update();
  assert.equal(vegetation.enabled, true, 'hysteresis restores it near the surface');
  controller.dispose();
});

test('underwater optimization stays disabled outside cinematic mode', () => {
  const system = renderSystem();
  const lighting = {
    enabled: true,
    setShadowRenderEnabled(value) { this.enabled = Boolean(value); },
  };
  const water = {
    calls: 0,
    surfaceLevelAt: () => 0,
    setPerformanceDepth() { this.calls += 1; },
  };
  const controller = new UnderwaterPerformanceController({
    camera: { position: { x: 0, y: -50, z: 0 } },
    water,
    cinematicLighting: lighting,
    vegetation: [system],
    config: { cinematic: { enabled: false, water: { underwaterPerformance: { enabled: true } } } },
  });

  controller.update();
  assert.equal(system.enabled, true);
  assert.equal(lighting.enabled, true);
  assert.equal(controller.depth, Number.NEGATIVE_INFINITY);
  assert.equal(controller.terrainOptions.underwaterDepth, Number.NEGATIVE_INFINITY);
});
