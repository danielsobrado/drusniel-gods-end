import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';
import * as THREE from 'three/webgpu';
import { CinematicPipeline } from '../src/rendering/CinematicPipeline.js';
import { SnowfallSystem } from '../src/weather/SnowfallSystem.js';
import { SnowPowderSystem } from '../src/world/SnowPowderSystem.js';
import { SnowDeformationField } from '../src/world/SnowDeformationField.js';

const snow = yaml.load(fs.readFileSync(new URL('../public/snow.yaml', import.meta.url), 'utf8'));
const look = yaml.load(fs.readFileSync(new URL('../public/cinematic-look.yaml', import.meta.url), 'utf8'));

function pipeline(enabled = true) {
  return new CinematicPipeline({ scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: {} }, {
    cinematic: { ...look.cinematic, enabled }, ui: { initialQuality: 'high' },
  });
}

test('regional setters remain safe with cinematic rendering disabled', () => {
  const p = pipeline(false);
  assert.doesNotThrow(() => {
    p.setShaftAtmosphere(1); p.setOcclusionScale(0.3); p.setSpeedStreaks(1); p.setFocusDistance(5);
  });
  p.dispose();
});

test('post-effect switches retain shaft targets and final disposal releases them', () => {
  const p = pipeline();
  const owned = p.shafts.passes ?? p.transient.filter(node => node.isRTTNode);
  assert.equal(owned.length, 2);
  let disposed = 0;
  for (const node of owned) node.renderTarget.addEventListener('dispose', () => disposed++);
  p.setEffect('sharpen', true);
  p.setEffect('sharpen', false);
  p.setEffect('lightShafts', false);
  p.setEffect('lightShafts', true);
  const current = p.shafts.passes ?? p.transient.filter(node => node.isRTTNode);
  assert.deepEqual(current.map(node => node.uuid), owned.map(node => node.uuid), 'changing the graph must retain shaft targets');
  p.dispose();
  assert.equal(disposed, 2, 'owned RTT render targets must be explicitly disposed');
});

function terrain(height = 0) {
  return {
    height, samples: 0, ranges: 0,
    sampleHeight() { this.samples++; return this.height; },
    getHeightRange() { this.ranges++; return { min: this.height, max: this.height }; },
  };
}

test('dormant lowland snowfall does not repeatedly sample terrain, and entering snow wakes it', () => {
  const ground = terrain();
  const field = new SnowfallSystem({ scene: new THREE.Scene(), terrainSampler: ground, config: snow });
  assert.equal(field.material.forceSinglePass, true);
  for (let i = 0; i < 60; i++) field.update(1 / 60, { x: i / 10, y: 3, z: 0 });
  assert.equal(field.mesh.visible, false);
  assert.equal(ground.samples, 0, 'conservative region exclusion should precede per-point terrain queries');
  assert.ok(ground.ranges < 5, 'reuse bounds within a region');
  ground.height = 175;
  field.update(0.1, { x: 500, y: 178, z: 500 });
  assert.equal(field.mesh.visible, true);
  assert.ok(ground.samples > 0);
  field.dispose();
});

test('ambient snow powder sleeps on bare lowlands and still wakes in snow', () => {
  const ground = terrain();
  const powder = new SnowPowderSystem({ scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), terrainSampler: ground, config: snow });
  assert.equal(powder.material.forceSinglePass, true);
  for (let i = 0; i < 60; i++) powder.update(1 / 60, { x: i / 10, y: 3, z: 0 });
  assert.equal(powder.activeCount, 0);
  assert.equal(ground.samples, 0);
  ground.height = 175;
  powder.update(0.1, { x: 500, y: 178, z: 500 });
  assert.ok(powder.activeCount > 0);
  powder.dispose();
});

test('footprint recovery preserves byte-for-byte decay while visiting only painted pixels', () => {
  const config = structuredClone(snow);
  config.ground.snow.deformation.resolution = 128;
  const field = new SnowDeformationField(config, terrain(175));
  field.update(0, { x: 0, z: 0 }, [{ position: { x: 0, y: 175, z: 0 }, radius: 0.3 }], true);
  const expected = field.pixels.slice();
  const dt = 0.21;
  const depression = Math.exp(-dt / field.config.decaySeconds);
  const berm = Math.exp(-dt / field.config.bermDecaySeconds);
  for (let i = 0; i < expected.length; i += 4) {
    expected[i] = Math.floor(expected[i] * depression);
    expected[i + 1] = Math.floor(expected[i + 1] * berm);
    expected[i + 2] = expected[i] === 0 ? 128 : Math.round(128 + (expected[i + 2] - 128) * depression);
    expected[i + 3] = expected[i] === 0 ? 128 : Math.round(128 + (expected[i + 3] - 128) * depression);
  }
  field.update(dt, { x: 0, z: 0 }, [], false);
  assert.deepEqual(field.pixels, expected);
  assert.ok(field.lastRecoveryPixels > 0 && field.lastRecoveryPixels < 100, 'recovery should visit occupied pixels, not the whole field');
  field.dispose();
});
