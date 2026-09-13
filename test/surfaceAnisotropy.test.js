import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import {
  applySurfaceAnisotropy,
  collectSurfaceAnisotropyTextures,
  resolveSurfaceAnisotropy,
} from '../src/rendering/SurfaceAnisotropyController.js';

const filteringConfig = yaml.load(
  fs.readFileSync(new URL('../public/surface-filtering.yaml', import.meta.url), 'utf8'),
);

function fakeTexture(anisotropy = 8) {
  return { isTexture: true, anisotropy, needsUpdate: false };
}

function fakeDemo() {
  const groundTexture = fakeTexture(16);
  const pathMask = fakeTexture(16);
  const forestPathTexture = fakeTexture(8);
  const unrelatedTexture = fakeTexture(8);
  const nodes = [
    { name: 'ForestPath', material: { map: forestPathTexture } },
    { name: 'Tree', material: { map: unrelatedTexture } },
  ];
  return {
    config: structuredClone(filteringConfig),
    world: {
      terrainTarget: {
        material: {
          userData: { textures: [groundTexture] },
        },
      },
      terrainSampler: { paths: { texture: pathMask } },
      expansion: { paths: { texture: pathMask } },
      scene: {
        traverse(callback) {
          for (const node of nodes) callback(node);
        },
      },
    },
    textures: { groundTexture, pathMask, forestPathTexture, unrelatedTexture },
  };
}

test('surface anisotropy is enabled by default to retain oblique ground detail', () => {
  assert.deepEqual(resolveSurfaceAnisotropy(filteringConfig), {
    enabled: true,
    level: 16,
  });
});

test('surface anisotropy applies consistently to terrain and named path textures', () => {
  const demo = fakeDemo();
  const textures = collectSurfaceAnisotropyTextures(demo);
  assert.equal(textures.size, 3);

  const disabled = applySurfaceAnisotropy(demo, false);
  assert.deepEqual(disabled, { enabled: false, level: 16, textures: 3 });
  assert.equal(demo.textures.groundTexture.anisotropy, 1);
  assert.equal(demo.textures.pathMask.anisotropy, 1);
  assert.equal(demo.textures.forestPathTexture.anisotropy, 1);
  assert.equal(demo.textures.unrelatedTexture.anisotropy, 8);

  const enabled = applySurfaceAnisotropy(demo, true);
  assert.deepEqual(enabled, { enabled: true, level: 16, textures: 3 });
  assert.equal(demo.config.renderer.surfaceAnisotropy.enabled, true);
  assert.equal(demo.textures.groundTexture.anisotropy, 16);
  assert.equal(demo.textures.pathMask.anisotropy, 16);
  assert.equal(demo.textures.forestPathTexture.anisotropy, 16);
  assert.ok(demo.textures.groundTexture.needsUpdate);
  assert.ok(demo.textures.pathMask.needsUpdate);
  assert.ok(demo.textures.forestPathTexture.needsUpdate);
});
