import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { GrassMaterial } from '../src/grass/GrassMaterial.js';

const RECOVERED_HEIGHT_HASH = 24634.6345;

function nodeGraphHasNumber(node, target, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  for (const value of Object.values(node)) {
    if (typeof value === 'number' && Math.abs(value - target) < 1e-6) return true;
    if (value && typeof value === 'object' && nodeGraphHasNumber(value, target, seen)) return true;
  }
  return false;
}

function grassParams() {
  return {
    bladeWidth: 0.12, bladeHeight: 1, bladeStiffness: 1.6, baseBend: 0.08,
    windIntensity: 1.1, windDirection: 35, windNoiseScale: 0.3, simulationSpeed: 1,
    sheen: 0.25, baseColor: '#3a5c32', tipColor: '#c8d48a',
  };
}

function harness({ cinematic = true, windModel = 'cinematic', normalTexture = null } = {}) {
  const texture = new THREE.Texture();
  const terrain = {
    getShaderData() {
      return {
        texture,
        normalTexture,
        boundsMin: new THREE.Vector3(-10, 0, -10),
        boundsSize: new THREE.Vector3(20, 4, 20),
        minHeight: 0,
        maxHeight: 4,
      };
    },
  };
  const mask = { vegetationTexture: texture };
  const interaction = {
    getShaderData() {
      return { texture, center: new THREE.Vector2(), worldSize: 12 };
    },
  };
  return new GrassMaterial({
    painter: { enabled: false },
    grass: { type: 'blade', blade: grassParams(), billboard: grassParams(), maxDistance: 80, tileSize: 25 },
    cinematic: cinematic
      ? { enabled: true, style: { enabled: true, bladeHeightScaleMin: 0.88, bladeHeightScaleMax: 1.22 } }
      : { enabled: false },
    wind: { model: windModel },
  }, terrain, mask, interaction, 'blade');
}

test('cinematic wind omits recovered wind and overwritten height hashes', () => {
  const material = harness();
  assert.equal(material.shaderFeatures.recoveredWind, false);
  assert.equal(material.shaderFeatures.recoveredHeightVariation, false);
  assert.equal(material.shaderFeatures.cinematicHeight, true);
  assert.equal(material.shaderFeatures.cinematicWind, true);
  assert.equal(material.shaderFeatures.sharedTerrainSample, true);
  assert.equal(material.shaderFeatures.skipDeformWhenInvisible, true);
  assert.equal(nodeGraphHasNumber(material.material.positionNode, RECOVERED_HEIGHT_HASH), false);
  material.dispose();
});

test('recovered wind model keeps recovered height hashes', () => {
  const material = harness({ cinematic: false, windModel: 'recovered' });
  assert.equal(material.shaderFeatures.recoveredWind, true);
  assert.equal(material.shaderFeatures.recoveredHeightVariation, true);
  assert.equal(material.shaderFeatures.cinematicHeight, false);
  material.dispose();
});

test('cached terrain normals are used only when a normal texture is supplied', () => {
  const fallback = harness({ normalTexture: null });
  assert.equal(fallback.shaderFeatures.cachedTerrainNormals, false);
  fallback.dispose();
  const cached = harness({ normalTexture: new THREE.Texture() });
  assert.equal(cached.shaderFeatures.cachedTerrainNormals, true);
  cached.dispose();
});
