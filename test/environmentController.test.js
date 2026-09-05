import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EnvironmentController } from '../src/world/EnvironmentController.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

// EnvironmentController latches once a preset transition settles: start, target
// and t are frozen from then on, so every later frame would recompute identical
// values and rewrite identical uniforms. Two of the tests below exist for
// reasons that are not obvious from reading them:
//
//   "the converged frame is applied, not skipped"
//     the latch must be set AFTER the converged update runs. Latching on the
//     previous frame's elapsed ends the transition one frame short of target.
//
//   "changing quality updates fog density in the settled steady state"
//     #apply() is what pushes quality.fogMultiplier into scene.fog.density, but
//     setQuality only assigns this.quality. Settled is the steady state and
//     quality is changed long after any transition, so without a re-apply a
//     quality change would silently stop updating fog.
//
// Both failed exactly as intended when deliberately reintroduced, so do not
// "simplify" them away.

const config = await loadMergedConfig();

function makeSinks() {
  const writes = [];
  const record = (path, value) => writes.push(`${path}=${value}`);

  const trackedColor = (path) => {
    const c = new THREE.Color();
    return new Proxy(c, {
      get(target, prop) {
        if (prop === 'copy') return (source) => { target.copy(source); record(path, target.getHexString()); return target; };
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  const wetMesh = {
    isMesh: true,
    userData: { rainRoughness: 0.1 },
    material: { roughness: 0.8 },
  };
  const scene = {
    fog: { color: trackedColor('fog.color'), density: 0 },
    environmentIntensity: 0,
    traverse(callback) {
      callback(wetMesh);
    },
  };
  const groundRain = {
    rippleAmount: { value: config.ground.rainRipple?.amount ?? 0.7 },
    setRain: (enabled) => record('ground.rain', enabled),
  };

  return {
    writes,
    scene,
    wetMesh,
    sun: { color: trackedColor('sun.color'), intensity: 0, position: new THREE.Vector3(), target: { position: new THREE.Vector3(), updateMatrixWorld() {} } },
    hemisphere: { color: trackedColor('hemi.sky'), groundColor: trackedColor('hemi.ground'), intensity: 0 },
    ambient: { color: trackedColor('ambient.color'), intensity: 0 },
    sky: { setPreset: (p) => record('sky.fogDensity', p.fogDensity) },
    clouds: { setCoverage: (v) => record('clouds.coverage', v) },
    grass: { setPreset: (p) => record('grass.bladeHeight', p.grass.blade.bladeHeight) },
    rain: {
      setIntensity: (v) => record('rain.intensity', v),
      setWindStrength: (v) => record('rain.wind', v),
    },
    water: { setRainIntensity: (v) => record('water.rainIntensity', v) },
    trees: {
      setWindSpeed: (v) => record('trees.windSpeed', v),
      setSimulationSpeed: (v) => record('trees.simulationSpeed', v),
    },
    leaves: {
      setWindStrength: (v) => record('leaves.windStrength', v),
      setSimulationSpeed: (v) => record('leaves.simulationSpeed', v),
    },
    audio: { setEnvironment() {}, playTransition() {} },
    terrain: { material: { userData: groundRain } },
    config,
  };
}

function build() {
  const sinks = makeSinks();
  return { controller: new EnvironmentController(sinks), sinks };
}

const presetNames = Object.keys(config.presets);
const qualityNames = Object.keys(config.quality);

test('fixture exposes more than one preset and quality', () => {
  assert.ok(presetNames.length >= 2, 'need two presets to test a transition');
  assert.ok(qualityNames.length >= 2, 'need two qualities to test the fog trap');
});

test('a transition converges to the target preset within TRANSITION_SECONDS', () => {
  const { controller, sinks } = build();
  controller.setPreset(presetNames[1]);
  for (let frame = 0; frame < 400; frame += 1) controller.update(1 / 60);

  const target = config.presets[presetNames[1]];
  assert.equal(
    sinks.scene.fog.density,
    target.sky.fogDensity * config.quality[controller.quality].fogMultiplier,
    'fog density must reach the target preset value',
  );
});

test('the converged frame is applied, not skipped', () => {
  const { controller, sinks } = build();
  controller.setPreset(presetNames[1]);
  controller.update(5);
  const target = config.presets[presetNames[1]];
  assert.equal(
    sinks.scene.fog.density,
    target.sky.fogDensity * config.quality[controller.quality].fogMultiplier,
    'the frame that reaches t=1 must still apply',
  );
});

test('changing quality updates fog density in the settled steady state', () => {
  const { controller, sinks } = build();
  for (let frame = 0; frame < 600; frame += 1) controller.update(1 / 60);

  const before = sinks.scene.fog.density;
  const other = qualityNames.find((name) => config.quality[name].fogMultiplier !== config.quality[controller.quality].fogMultiplier);
  assert.ok(other, 'need two qualities with different fogMultiplier');

  controller.setQuality(other);
  controller.update(1 / 60);

  const expected = controller.current.sky.fogDensity * config.quality[other].fogMultiplier;
  assert.equal(sinks.scene.fog.density, expected, 'quality change must update fog density');
  assert.notEqual(sinks.scene.fog.density, before, 'fog density should actually have changed');
});

test('a new preset restarts the transition after settling', () => {
  const { controller, sinks } = build();
  for (let frame = 0; frame < 600; frame += 1) controller.update(1 / 60);

  controller.setPreset(presetNames[1]);
  const writesBefore = sinks.writes.length;
  controller.update(1 / 60);
  assert.ok(sinks.writes.length > writesBefore, 'a new preset must resume applying');
});

test('setGrassParameter applies immediately even when settled', () => {
  const { controller, sinks } = build();
  for (let frame = 0; frame < 600; frame += 1) controller.update(1 / 60);

  const writesBefore = sinks.writes.length;
  controller.setGrassParameter('bladeHeight', 1.234);
  assert.ok(sinks.writes.length > writesBefore, 'setGrassParameter must apply immediately');
  assert.ok(sinks.writes.includes('grass.bladeHeight=1.234'));
});

test('settled frames stop rewriting uniforms', () => {
  const { controller, sinks } = build();
  for (let frame = 0; frame < 600; frame += 1) controller.update(1 / 60);

  const writesBefore = sinks.writes.length;
  for (let frame = 0; frame < 60; frame += 1) controller.update(1 / 60);
  assert.equal(sinks.writes.length, writesBefore, 'settled frames should not rewrite uniforms');
});

test('rain intensity is continuously interpolated during preset transitions', () => {
  const rainPreset = presetNames.find((name) => config.presets[name].rain);
  const dryPreset = presetNames.find((name) => !config.presets[name].rain);
  assert.ok(rainPreset && dryPreset, 'need both dry and rainy presets');

  const { controller, sinks } = build();
  controller.setPreset(dryPreset);
  controller.update(5);
  controller.setPreset(rainPreset);
  sinks.writes.length = 0;
  controller.update(2.5);

  const waterWrite = sinks.writes.findLast((entry) => entry.startsWith('water.rainIntensity='));
  assert.ok(waterWrite, 'water should receive the interpolated rain intensity');
  const value = Number(waterWrite.split('=')[1]);
  assert.ok(value > 0 && value < 1, 'halfway through the transition rain must be fractional');
  assert.equal(sinks.terrain.material.userData.rippleAmount.value, (config.ground.rainRipple?.amount ?? 0.7) * value);
  assert.ok(sinks.wetMesh.material.roughness < 0.8 && sinks.wetMesh.material.roughness > 0.1);
});

test('environment wind and simulation speed use recovered subsystem multipliers', () => {
  const { controller, sinks } = build();
  sinks.writes.length = 0;
  controller.setGrassParameter('windIntensity', 1.25);
  controller.setGrassParameter('simulationSpeed', 0.75);

  assert.equal(
    sinks.writes.findLast((entry) => entry.startsWith('trees.windSpeed=')),
    `trees.windSpeed=${1.25 * config.trees.windSpeedMultiplier}`,
  );
  assert.equal(
    sinks.writes.findLast((entry) => entry.startsWith('leaves.windStrength=')),
    `leaves.windStrength=${1.25 * config.leaves.windStrengthMultiplier}`,
  );
  assert.equal(
    sinks.writes.findLast((entry) => entry.startsWith('rain.wind=')),
    `rain.wind=${1.25 * (config.rain.windStrengthMultiplier ?? 10)}`,
  );
  assert.equal(
    sinks.writes.findLast((entry) => entry.startsWith('trees.simulationSpeed=')),
    'trees.simulationSpeed=0.75',
  );
  assert.equal(
    sinks.writes.findLast((entry) => entry.startsWith('leaves.simulationSpeed=')),
    'leaves.simulationSpeed=0.75',
  );
});
