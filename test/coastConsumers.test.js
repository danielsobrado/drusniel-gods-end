import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ProceduralVegetationField } from '../src/grass/ProceduralVegetationField.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

const merged = await loadMergedConfig();

function terrainFixture() {
  return {
    bounds: new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(80, 10, 20),
    ),
    size: new THREE.Vector3(80, 10, 20),
    paths: { sample: () => 0 },
    river: null,
    sampleHeight: () => 0,
  };
}

function vegetationConfig(curve) {
  const config = structuredClone(merged);
  config.terrain.expansion.enabled = false;
  config.vegetation.resolution = 3;
  config.vegetation.buildChunkRows = 10;
  config.vegetation.moisture.waterDistance = 20;
  config.vegetation.moisture.waterWeight = 1;
  config.vegetation.moisture.lowlandWeight = 0;
  config.vegetation.moisture.noiseWeight = 0;
  config.water.size = 0;
  config.water.sea = {
    ...config.water.sea,
    enabled: true,
    level: -24,
    shoreX: 0,
    coast: { ...config.water.sea.coast, curve },
  };
  return config;
}

test('vegetation water proximity follows the configured coast curve', async () => {
  const defaultCurve = {
    longFrequency: 0.005,
    longAmplitude: 65,
    shortFrequency: 0.014,
    shortAmplitude: 18,
  };
  const displacedCurve = {
    longFrequency: 0.1,
    longAmplitude: 80,
    shortFrequency: 0.014,
    shortAmplitude: 0,
  };
  const defaultField = new ProceduralVegetationField(
    vegetationConfig(defaultCurve),
    terrainFixture(),
  );
  const displacedField = new ProceduralVegetationField(
    vegetationConfig(displacedCurve),
    terrainFixture(),
  );

  try {
    await defaultField.build();
    await displacedField.build();
    assert.ok(defaultField.sampleWorld(40, 10).moisture > 0.95);
    assert.ok(displacedField.sampleWorld(40, 10).moisture < 0.05);
  } finally {
    defaultField.dispose();
    displacedField.dispose();
  }
});
