import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {
  isCoastalJungleFoliageMaterial,
  prepareCoastalJungleMaterial,
  prepareCoastalJungleTexture,
} from '../src/biome/CoastalJungleMaterial.js';

test('coastal jungle identifies atlas materials as foliage', () => {
  const material = new THREE.MeshStandardMaterial();
  material.name = 'tropical_leaf_atlas';
  assert.equal(isCoastalJungleFoliageMaterial(material, 'broadleaf'), true);
});

test('coastal jungle texture preparation restores runtime sampling quality', () => {
  const map = new THREE.Texture();
  prepareCoastalJungleTexture(map, { anisotropy: 8, colorTexture: true });
  assert.equal(map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(map.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(map.magFilter, THREE.LinearFilter);
  assert.equal(map.anisotropy, 8);
  assert.equal(map.generateMipmaps, true);
});

test('coastal jungle foliage gets source-style cutout, depth haze and wind nodes', () => {
  const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), roughness: 0.4 });
  material.name = 'jungle_grass_atlas';
  prepareCoastalJungleMaterial(material, {
    kind: 'grass',
    instanced: true,
    cinematic: true,
    settings: {
      alphaTest: 0.4,
      shadowAlphaTest: 0.48,
      foliageRoughnessMin: 0.84,
      ambientLift: 0.035,
      backlight: 0.18,
      haze: { enabled: true, color: '#91b1b7', start: 18, end: 85, strength: 0.28 },
      wind: { enabled: true, amplitude: 0.035, speed: 1.4, spatialX: 0.7, spatialZ: 0.6 },
    },
  });
  assert.equal(material.alphaTest, 0.4);
  assert.equal(material.side, THREE.DoubleSide);
  assert.equal(material.depthWrite, true);
  assert.equal(material.transparent, false);
  assert.equal(material.roughness, 0.84);
  assert.equal(material.metalness, 0);
  assert.ok(material.alphaTestNode);
  assert.ok(material.colorNode);
  assert.ok(material.maskShadowNode);
  assert.ok(material.emissiveNode);
  assert.ok(material.positionNode);
});
