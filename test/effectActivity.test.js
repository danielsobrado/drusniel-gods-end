import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';
import * as THREE from 'three/webgpu';
import { CinematicPipeline } from '../src/rendering/CinematicPipeline.js';
import { SnowfallSystem } from '../src/weather/SnowfallSystem.js';
import { SnowPowderSystem } from '../src/world/SnowPowderSystem.js';
import { SnowDeformationField } from '../src/world/SnowDeformationField.js';
import { SnowRegionBounds } from '../src/world/SnowRegionBounds.js';
import { EffectTarget } from '../src/rendering/EffectTarget.js';
import { vec4 } from 'three/tsl';

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

test('inactive effect targets initialize once and refresh at current resolution on reactivation', () => {
  const target = new EffectTarget(vec4(1));
  let draws = 0, active = false, size = 100, current = null;
  target._quadMesh.render = () => draws++;
  target.isActive = () => active;
  const state = {
    cubeFace: 0,
    mipLevel: 0,
    renderObjectFunction: null,
    pixelRatio: 1,
    mrt: null,
    clearColor: new THREE.Color(0),
    clearAlpha: 1,
    scissorTest: false,
  };
  const frame = { renderer: {
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace,
    autoClear: true,
    getRenderTarget: () => current,
    setRenderTarget: (value, cubeFace = 0, mipLevel = 0) => {
      current = value; state.cubeFace = cubeFace; state.mipLevel = mipLevel;
    },
    getActiveCubeFace: () => state.cubeFace,
    getActiveMipmapLevel: () => state.mipLevel,
    getRenderObjectFunction: () => state.renderObjectFunction,
    setRenderObjectFunction: value => { state.renderObjectFunction = value; },
    getPixelRatio: () => state.pixelRatio,
    setPixelRatio: value => { state.pixelRatio = value; },
    getMRT: () => state.mrt,
    setMRT: value => { state.mrt = value; },
    getClearColor: result => result.copy(state.clearColor),
    getClearAlpha: () => state.clearAlpha,
    setClearColor: (value, alpha = 1) => { state.clearColor.set(value); state.clearAlpha = alpha; },
    getScissorTest: () => state.scissorTest,
    setScissorTest: value => { state.scissorTest = value; },
    getDrawingBufferSize: result => result.set(size, size),
  } };
  target.updateBefore(frame);
  target.updateBefore(frame);
  assert.equal(draws, 1, 'a dormant effect is prepared once');
  size = 200;
  target.updateBefore(frame);
  assert.equal(draws, 1);
  active = true;
  target.updateBefore(frame);
  assert.equal(draws, 2);
  assert.equal(target.renderTarget.width, 200);
  assert.equal(current, null);
  let disposed = 0;
  target.renderTarget.addEventListener('dispose', () => disposed++);
  target._quadMesh.material.addEventListener('dispose', () => disposed++);
  target.dispose();
  assert.equal(disposed, 2);
});

test('snow rejection bounds include emitter edges and the maximum possible wind drift', () => {
  const config = structuredClone(snow);
  config.ground.snow.wind.driftHeight = 10;
  config.ground.snow.wind.scourStrength = -2;
  let bounds;
  const region = new SnowRegionBounds({ getHeightRange(box) {
    bounds = box.clone();
    return { max: config.ground.snow.altitude.start - 11 };
  } }, config, 25);
  assert.equal(region.contains(63.99, -0.01), true);
  assert.deepEqual([bounds.min.x, bounds.max.x, bounds.min.z, bounds.max.z], [-25, 89, -89, 25]);
  assert.equal(new SnowRegionBounds({}, config).contains(0, 0), true, 'missing bounds must not reject snow');
  assert.equal(new SnowRegionBounds({ getHeightRange: () => ({ max: NaN }) }, config).contains(0, 0), true);
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
  for (let i = 0; i < 60; i++) {
    const position = { x: i / 10, y: 0, z: 0 };
    powder.update(1 / 60, position, [{ position, radius: 0.3 }], true);
  }
  assert.equal(powder.activeCount, 0);
  assert.equal(ground.samples, 0);
  ground.height = 175;
  powder.update(0.1, { x: 500, y: 178, z: 500 });
  assert.ok(powder.activeCount > 0);
  powder.dispose();
});

test('footprint contact queries sleep away from snow and sand', () => {
  const ground = terrain();
  const field = new SnowDeformationField(snow, ground);
  for (let i = 0; i < 60; i++) {
    const position = { x: i / 10, y: 0, z: 0 };
    field.update(1 / 60, position, [{ position, radius: 0.3 }], true);
  }
  assert.equal(ground.samples, 0);
  assert.equal(field.peak, 0);
  field.dispose();
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
