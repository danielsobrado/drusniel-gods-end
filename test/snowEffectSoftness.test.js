import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { DataTexture, Scene, PerspectiveCamera } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { createSnowWakeMaterial } from '../src/world/SnowWakeMaterial.js';
import { resolveSnowWakeConfig } from '../src/config/resolveSnowWakeConfig.js';
import { SnowPowderSystem } from '../src/world/SnowPowderSystem.js';

const config = yaml.load(await readFile(new URL('../public/snow.yaml', import.meta.url), 'utf8'));

test('the snow wake blends soft edges without opaque depth or a hard alpha cutout', () => {
  const settings = resolveSnowWakeConfig(config.ground.snow.wake);
  const material = createSnowWakeMaterial({
    spineTexture: new DataTexture(), uniforms: { scale: uniform(1), count: uniform(2) },
    columns: settings.columns, rows: settings.rows, settings, snow: config.ground.snow,
  });
  assert.equal(material.transparent, true);
  assert.equal(material.depthWrite, false);
  assert.equal(material.forceSinglePass, true);
  assert.equal(material.alphaTest, 0);
  material.dispose();
});

test('powder fades in and out through alpha while keeping a stable particle footprint', () => {
  const powder = new SnowPowderSystem({ config, scene: new Scene(), camera: new PerspectiveCamera(),
    terrainSampler: { sampleHeight: () => -1000 } });
  const alpha = powder.geometry.getAttribute('powderAlpha');
  assert.ok(alpha, 'particle age must control transparency instead of only shrinking a solid disc');
  powder.emit(0, 10, 0, 0, 0, 0, 1, 1);
  powder.update(0.01, null);
  const entering = alpha.getX(0);
  assert.ok(entering > 0 && entering < 0.2);
  powder.update(0.09, null);
  const fresh = alpha.getX(0);
  assert.ok(fresh > entering);
  for (let i = 0; i < 8; i++) powder.update(0.1, null);
  assert.ok(alpha.getX(0) > 0 && alpha.getX(0) < fresh * 0.2);
  // Aging changes opacity, not a shrinking hard-edged silhouette.
  const matrix = powder.mesh.instanceMatrix.array;
  assert.ok(Math.hypot(matrix[0], matrix[1], matrix[2]) >= 1);
  for (let i = 0; i < 3; i++) powder.update(0.1, null);
  assert.equal(powder.mesh.visible, false);
  powder.dispose();
});

test('powder compacts sparse live particles into the rendered instance range', () => {
  const powder = new SnowPowderSystem({ config, scene: new Scene(), camera: new PerspectiveCamera(),
    terrainSampler: { sampleHeight: () => -1000 } });
  powder.emit(1, 10, 0, 0, 0, 0, 1, 0.05);
  powder.emit(7, 10, 0, 0, 0, 0, 1, 1);
  powder.update(0.1, null);

  assert.equal(powder.activeCount, 1);
  assert.equal(powder.mesh.count, 1, 'dead slots must not stay in the GPU draw range');
  assert.ok(Math.abs(powder.mesh.instanceMatrix.array[12] - powder.positions[3]) < 1e-6,
    'the live sparse slot must be compacted into rendered slot zero');
  assert.ok(powder.geometry.getAttribute('powderAlpha').getX(0) > 0);
  powder.dispose();
});

test('wake opacity controls reject values that would break blending', () => {
  assert.throws(() => resolveSnowWakeConfig({ ...config.ground.snow.wake, opacity: 1.1 }), /opacity/);
  assert.throws(() => resolveSnowWakeConfig({ ...config.ground.snow.wake, alphaSoftness: 0 }), /alphaSoftness/);
});
