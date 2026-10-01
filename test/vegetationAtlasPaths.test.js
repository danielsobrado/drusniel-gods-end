import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { coverageTexture, vegetationAtlasPaths } from '../src/foliage/VegetationLodAssets.js';

const entry = { atlas: 'tree1.webp', atlasKtx2: 'tree1.ktx2' };

test('vegetation atlases prefer KTX2 only when compressed loading is usable', () => {
  const enabled = { vegetationLod: { ktx2: { enabled: true } } };
  assert.deepEqual(vegetationAtlasPaths(entry, enabled, true), {
    compressed: 'tree1.ktx2',
    fallback: 'tree1.webp',
  });
  assert.deepEqual(vegetationAtlasPaths(entry, enabled, false), {
    compressed: null,
    fallback: 'tree1.webp',
  });
});

test('vegetation atlases retain WebP fallback when KTX2 is disabled or absent', () => {
  assert.deepEqual(
    vegetationAtlasPaths(entry, { vegetationLod: { ktx2: { enabled: false } } }, true),
    { compressed: null, fallback: 'tree1.webp' },
  );
  assert.deepEqual(
    vegetationAtlasPaths({ atlas: 'tree1.webp' }, { vegetationLod: { ktx2: { enabled: true } } }, true),
    { compressed: null, fallback: 'tree1.webp' },
  );
});

test('provided foliage mipmaps are not replaced by runtime generation', () => {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.mipmaps = [{ data: texture.image.data, width: 1, height: 1 }];
  coverageTexture(texture, 'test');
  assert.equal(texture.generateMipmaps, false);
  texture.dispose();
});


test('coverage textures honor configured foliage anisotropy', () => {
  const texture = new THREE.Texture();
  coverageTexture(texture, 'tree-atlas', 2);
  assert.equal(texture.anisotropy, 2);
  texture.dispose();
});
