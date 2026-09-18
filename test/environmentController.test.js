import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EnvironmentController } from '../src/world/EnvironmentController.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

// EnvironmentController no longer interpolates: a preset change is a hard cut,
// played by the caller behind a closed iris. Two of the tests below exist for
// reasons that are not obvious from reading them:
//
//   "the sun does not travel between presets"
//     the old 5s cross-fade lerped lighting.position and sky.sunPosition, which
//     read on screen as a time-lapse of the time of day. This pins the cut.
//
//   "changing quality updates fog density"
//     #apply() is what pushes quality.fogMultiplier into scene.fog.density, but
//     setQuality only assigns this.quality. Without a re-apply a quality change
//     would silently stop updating fog.
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

test('setPreset applies the target preset immediately, with no cross-fade', () => {
  const { controller, sinks } = build();
  controller.setPreset(presetNames[1]);

  const target = config.presets[presetNames[1]];
  assert.equal(
    sinks.scene.fog.density,
    target.sky.fogDensity * config.quality[controller.quality].fogMultiplier,
    'fog density must be the target value on the same call, without an update() frame',
  );
});

test('the sun does not travel between presets', () => {
  const origin = new THREE.Vector3();
  const { controller, sinks } = build();
  controller.setPreset(presetNames[0]);
  controller.updateSunTarget(origin);
  const first = sinks.sun.position.clone();

  const moved = presetNames.find(
    (name) => !new THREE.Vector3().fromArray(config.presets[name].lighting.position).equals(first),
  );
  assert.ok(moved, 'need a preset whose sun sits somewhere else');

  controller.setPreset(moved);
  controller.updateSunTarget(origin);
  assert.deepEqual(
    sinks.sun.position.toArray(),
    config.presets[moved].lighting.position,
    'the sun must cut straight to the new position, never sweep across the sky',
  );
});

test('changing quality updates fog density', () => {
  const { controller, sinks } = build();
  const before = sinks.scene.fog.density;
  const other = qualityNames.find((name) => config.quality[name].fogMultiplier !== config.quality[controller.quality].fogMultiplier);
  assert.ok(other, 'need two qualities with different fogMultiplier');

  controller.setQuality(other);

  const expected = controller.current.sky.fogDensity * config.quality[other].fogMultiplier;
  assert.equal(sinks.scene.fog.density, expected, 'quality change must update fog density');
  assert.notEqual(sinks.scene.fog.density, before, 'fog density should actually have changed');
});

test('a second preset replaces the first', () => {
  const { controller, sinks } = build();
  controller.setPreset(presetNames[1]);
  controller.setPreset(presetNames[0]);

  const target = config.presets[presetNames[0]];
  assert.equal(
    sinks.scene.fog.density,
    target.sky.fogDensity * config.quality[controller.quality].fogMultiplier,
  );
});

test('setGrassParameter applies immediately', () => {
  const { controller, sinks } = build();
  const writesBefore = sinks.writes.length;
  controller.setGrassParameter('bladeHeight', 1.234);
  assert.ok(sinks.writes.length > writesBefore, 'setGrassParameter must apply immediately');
  assert.ok(sinks.writes.includes('grass.bladeHeight=1.234'));
});

test('rain reaches full intensity on the preset change itself', () => {
  const rainPreset = presetNames.find((name) => config.presets[name].rain);
  const dryPreset = presetNames.find((name) => !config.presets[name].rain);
  assert.ok(rainPreset && dryPreset, 'need both dry and rainy presets');

  const { controller, sinks } = build();
  controller.setPreset(dryPreset);
  sinks.writes.length = 0;
  controller.setPreset(rainPreset);

  assert.equal(
    sinks.writes.findLast((entry) => entry.startsWith('water.rainIntensity=')),
    'water.rainIntensity=1',
    'rain must arrive at full strength, not ramp up over a transition',
  );
  assert.equal(
    sinks.terrain.material.userData.rippleAmount.value,
    config.ground.rainRipple?.amount ?? 0.7,
  );
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

test('snow country lowers the sun and restores the preset light on the way down', () => {
  const origin = new THREE.Vector3();
  const { controller, sinks } = build();
  const preset = config.presets[controller.currentPreset].lighting;
  const elevation = (v) => Math.atan2(v.y, Math.hypot(v.x, v.z));

  controller.setSnowRegion(1);
  controller.updateSunTarget(origin);
  const settings = controller.snowAtmosphere;
  assert.ok(Math.abs(elevation(sinks.sun.position) - settings.sunElevation) < 1e-6);
  assert.equal(sinks.sun.intensity, preset.directionalIntensity * settings.sunIntensityScale);
  assert.equal(controller.exposureScale, settings.exposureScale);

  controller.setSnowRegion(0);
  controller.updateSunTarget(origin);
  assert.deepEqual(sinks.sun.position.toArray(), preset.position);
  assert.equal(sinks.sun.intensity, preset.directionalIntensity);
  assert.equal(controller.exposureScale, 1);
});
