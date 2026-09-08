import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { GrassDemo } from '../src/app/GrassDemo.js';
import { EnvironmentController } from '../src/world/EnvironmentController.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

async function fixture() {
  const config = await loadMergedConfig();
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2();
  const environment = new EnvironmentController({ config, scene,
    sun: new THREE.DirectionalLight(), hemisphere: new THREE.HemisphereLight(),
    ambient: new THREE.AmbientLight(), grass: { setPreset() {} } });
  const capture = () => GrassDemo.prototype.captureSessionState.call({ config, environment });
  return { config, environment, capture };
}

test('recovery leaves distinct blade and billboard preset values intact', async () => {
  const { config, capture } = await fixture();
  const grass = config.presets[config.ui.initialPreset].grass;
  assert.notEqual(grass.blade.bladeHeight, grass.billboard.bladeHeight);
  assert.deepEqual(capture().grassParameters, {}, 'preset defaults must not be replayed as global overrides');
});

test('recovery captures only explicit grass edits and resets them on a preset change', async () => {
  const { config, environment, capture } = await fixture();
  environment.setGrassParameter('windIntensity', 2.3);
  environment.setGrassParameter('simulationSpeed', 0.7);
  environment.setGrassParameter('windIntensity', NaN);
  environment.setGrassParameter('unknown', 3);
  const saved = capture();
  assert.deepEqual(saved.grassParameters, { windIntensity: 2.3, simulationSpeed: 0.7 });
  environment.setGrassParameter('windIntensity', 0.5);
  assert.equal(saved.grassParameters.windIntensity, 2.3, 'saved state owns its copy');
  environment.setPreset(Object.keys(config.presets).find(name => name !== environment.currentPreset));
  assert.deepEqual(capture().grassParameters, {});
});
