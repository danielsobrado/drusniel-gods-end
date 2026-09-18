import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';
import { validateSnowConfig } from '../src/config/validateSnowConfig.js';
import {
  SnowRegionTracker,
  blendSnowAtmosphere,
  resolveSnowAtmosphereConfig,
  snowRegionWeight,
} from '../src/world/SnowAtmosphere.js';

const config = await loadMergedConfig();
const settings = resolveSnowAtmosphereConfig(config);

function preset(position = [-28, 65, -30]) {
  return {
    lighting: {
      color: new THREE.Color('#fff0c9'),
      directionalIntensity: 2.8,
      position: new THREE.Vector3(...position),
      hemisphereSkyColor: new THREE.Color('#b6def1'),
      hemisphereGroundColor: new THREE.Color('#78945d'),
      hemisphereIntensity: 0.95,
      ambientColor: new THREE.Color('#dceac5'),
      ambientIntensity: 0.32,
      environmentIntensity: 0.65,
    },
    sky: {
      horizonColor: new THREE.Color('#c5e7df'),
      zenithColor: new THREE.Color('#438ec5'),
      fogColor: new THREE.Color('#a5ced3'),
      fogDensity: 0.0011,
      sunPosition: new THREE.Vector3(...position),
    },
  };
}

const elevation = (v) => Math.atan2(v.y, Math.hypot(v.x, v.z));
const azimuth = (v) => Math.atan2(v.z, v.x);

test('snow-country light is configured and blends in by ground height', () => {
  assert.ok(settings, 'the atmosphere is enabled in snow.yaml');
  assert.equal(snowRegionWeight(20, settings), 0, 'the meadow keeps its preset light');
  assert.equal(snowRegionWeight(settings.fullHeight + 1, settings), 1, 'the summit is fully snow country');
  assert.equal(snowRegionWeight(Number.NaN, settings), 0);
});

test('a zero weight leaves the preset untouched', () => {
  const source = preset();
  const out = blendSnowAtmosphere(source, settings, 0);
  assert.ok(out.lighting.position.equals(source.lighting.position));
  assert.ok(out.lighting.hemisphereGroundColor.equals(source.lighting.hemisphereGroundColor));
  assert.equal(out.lighting.directionalIntensity, source.lighting.directionalIntensity);
  assert.equal(out.fogDensity, source.sky.fogDensity);
  assert.equal(out.exposureScale, 1);
  assert.equal(out.occlusionScale, 1);
});

test('full snow country lowers the sun without turning it and relights the ground as snow', () => {
  const source = preset();
  const out = blendSnowAtmosphere(source, settings, 1);
  assert.ok(Math.abs(elevation(out.lighting.position) - settings.sunElevation) < 1e-9);
  assert.ok(Math.abs(azimuth(out.lighting.position) - azimuth(source.lighting.position)) < 1e-9);
  assert.ok(Math.abs(out.lighting.position.length() - source.lighting.position.length()) < 1e-9);
  assert.ok(Math.abs(elevation(out.sky.sunPosition) - settings.sunElevation) < 1e-9, 'the sky disc follows the light');
  assert.ok(out.lighting.directionalIntensity > source.lighting.directionalIntensity);
  assert.ok(out.lighting.ambientIntensity < source.lighting.ambientIntensity);
  // Snow bounce is brighter and bluer than the meadow's green ground light.
  const ground = out.lighting.hemisphereGroundColor;
  assert.ok(ground.b > ground.g && ground.getHSL({}).l > source.lighting.hemisphereGroundColor.getHSL({}).l);
  assert.equal(out.exposureScale, settings.exposureScale);
  assert.equal(out.occlusionScale, settings.occlusionScale);
});

test('a sun already below the snow-country elevation is never raised', () => {
  const low = preset([-60, 10, -64]);
  const out = blendSnowAtmosphere(low, settings, 1);
  assert.ok(Math.abs(elevation(out.lighting.position) - elevation(low.lighting.position)) < 1e-9);
});

test('the region weight eases while walking and snaps on a teleport', () => {
  const terrainSampler = { sampleHeight: (x) => (x > 500 ? 400 : 0) };
  const tracker = new SnowRegionTracker({ terrainSampler, settings });
  assert.equal(tracker.update(1 / 60, { x: 0, z: 0 }), 0);
  tracker.settings = { ...settings, snapDistance: 1000 };
  const eased = tracker.update(1 / 60, { x: 600, z: 0 });
  assert.ok(eased > 0 && eased < 0.1, `walking in eases (${eased})`);
  tracker.settings = settings;
  assert.equal(tracker.update(1 / 60, { x: 0, z: 0 }), 0, 'a long jump snaps');
  assert.equal(tracker.update(1 / 60, { x: 900, z: 0 }), 1);
});

test('snow validation rejects an inverted atmosphere ramp and an impossible sun', () => {
  const inverted = structuredClone(config);
  inverted.ground.snow.atmosphere.fullHeight = inverted.ground.snow.atmosphere.startHeight;
  assert.throws(() => validateSnowConfig(inverted), /atmosphere\.fullHeight/);

  const sunBelow = structuredClone(config);
  sunBelow.ground.snow.atmosphere.sunElevationDegrees = 0;
  assert.throws(() => validateSnowConfig(sunBelow), /sunElevationDegrees/);

  const occlusion = structuredClone(config);
  occlusion.ground.snow.atmosphere.occlusionScale = 1.5;
  assert.throws(() => validateSnowConfig(occlusion), /occlusionScale/);

  const disabled = structuredClone(config);
  disabled.ground.snow.atmosphere.enabled = false;
  assert.equal(resolveSnowAtmosphereConfig(disabled), null);
});
