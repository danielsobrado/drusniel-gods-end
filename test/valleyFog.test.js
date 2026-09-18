import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';
import * as THREE from 'three';
import { uniform } from 'three/tsl';
import { resolveValleyFogConfig } from '../src/config/resolveValleyFogConfig.js';
import { validateSnowConfig } from '../src/config/validateSnowConfig.js';
import { createValleyFogNodes } from '../src/rendering/valleyFog.js';

const snowConfig = yaml.load(fs.readFileSync(new URL('../public/snow.yaml', import.meta.url), 'utf8'));

function withValleyFog(patch) {
  const config = structuredClone(snowConfig);
  Object.assign(config.ground.snow.atmosphere.valleyFog, patch);
  return config;
}

test('valley fog resolves from the snow atmosphere and switches off with it', () => {
  const settings = resolveValleyFogConfig(snowConfig);
  assert.ok(settings.density > 0 && settings.height > 0);
  assert.ok(settings.ceiling > settings.height, 'mist thins out before its ceiling');
  assert.ok(settings.nearEnd > settings.nearStart);
  assert.ok(Number.isInteger(settings.samples));
  assert.equal(settings.windAngleDegrees, snowConfig.ground.snow.wind.angleDegrees);

  assert.equal(resolveValleyFogConfig(withValleyFog({ enabled: false })), null);
  const noAtmosphere = structuredClone(snowConfig);
  noAtmosphere.ground.snow.atmosphere.enabled = false;
  assert.equal(resolveValleyFogConfig(noAtmosphere), null);
});

test('valley fog validation rejects an inverted near clearing and a runaway march', () => {
  assert.throws(() => validateSnowConfig(withValleyFog({ nearClear: [40, 6] })), /valleyFog\.nearClear/);
  assert.throws(() => validateSnowConfig(withValleyFog({ samples: 64 })), /valleyFog\.samples/);
  assert.throws(() => validateSnowConfig(withValleyFog({ scatter: 1 })), /valleyFog\.scatter/);
});

test('valley fog nodes need a terrain heightfield', () => {
  const settings = resolveValleyFogConfig(snowConfig);
  const lighting = {
    weight: uniform(0),
    fogColor: uniform(new THREE.Color('#dfe6ee')),
    sunDirection: uniform(new THREE.Vector3(0, 1, 0)),
    sunColor: uniform(new THREE.Color('#ffffff')),
  };
  assert.equal(createValleyFogNodes({ settings, terrainSampler: null, ...lighting }), null);
  assert.equal(createValleyFogNodes({ settings: null, terrainSampler: {}, ...lighting }), null);

  const terrainSampler = {
    texture: new THREE.DataTexture(new Uint8Array(16), 2, 2),
    bounds: new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 50, 10)),
    size: new THREE.Vector3(20, 50, 20),
  };
  const nodes = createValleyFogNodes({ settings, terrainSampler, ...lighting });
  assert.ok(nodes?.factor?.isNode && nodes?.color?.isNode);
});
