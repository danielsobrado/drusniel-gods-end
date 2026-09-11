import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EnvironmentController } from '../src/world/EnvironmentController.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

const merged = await loadMergedConfig();

function createController(config, moisture, qualityCalls) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2('#000000', 0);
  const groundcover = new THREE.Group();
  groundcover.name = 'Coastal groundcover';
  groundcover.userData.setQuality = (quality) => qualityCalls.push(quality);
  scene.add(groundcover);
  const sun = new THREE.DirectionalLight();
  scene.add(sun, sun.target);
  const hemisphere = new THREE.HemisphereLight();
  const ambient = new THREE.AmbientLight();
  const terrain = {
    material: {
      userData: {
        beachMoisture: moisture,
        rippleAmount: { value: 0 },
        setRainIntensity() {},
      },
    },
  };
  return new EnvironmentController({
    scene,
    sun,
    hemisphere,
    ambient,
    sky: { setPreset() {} },
    clouds: { setCoverage() {} },
    grass: { setPreset() {} },
    rain: { setIntensity() {}, setWindStrength() {} },
    water: { setRainIntensity() {} },
    trees: { setWindSpeed() {}, setSimulationSpeed() {} },
    leaves: { setWindStrength() {}, setSimulationSpeed() {} },
    terrain,
    config,
  });
}

test('fresh rainy construction starts wet while later preset and quality changes do not reseed moisture', () => {
  const rainy = Object.keys(merged.presets).find((name) => {
    const preset = merged.presets[name];
    return (preset.rainIntensity ?? (preset.rain ? 1 : 0)) > 0;
  });
  const dry = Object.keys(merged.presets).find((name) => {
    const preset = merged.presets[name];
    return (preset.rainIntensity ?? (preset.rain ? 1 : 0)) === 0;
  });
  assert.ok(rainy && dry);
  const config = structuredClone(merged);
  config.ui.initialPreset = rainy;
  const moisture = { value: 0 };
  const qualityCalls = [];
  const controller = createController(config, moisture, qualityCalls);
  assert.equal(moisture.value, controller.current.rainIntensity);
  assert.ok(moisture.value > 0);

  const seeded = moisture.value;
  controller.setPreset(dry);
  assert.equal(moisture.value, seeded);
  const quality = Object.keys(config.quality).find((name) => name !== controller.quality);
  controller.setQuality(quality);
  assert.equal(moisture.value, seeded);
  assert.deepEqual(qualityCalls, [quality]);
});
