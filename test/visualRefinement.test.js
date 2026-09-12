import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { nearshoreWavePhase, resolveSeaWaves } from '../src/water/seaWaves.js';

const refinement = yaml.load(fs.readFileSync(
  new URL('../public/visual-refinement.yaml', import.meta.url),
  'utf8',
));

test('meadow refinement reduces carpet density and preserves broad height variation', () => {
  assert.ok(refinement.quality.high.blade.lod.high.density < 4.5);
  assert.ok(refinement.vegetation.density.base < 0.84);
  assert.ok(refinement.vegetation.density.macroVariation > 0.28);
  assert.ok(refinement.cinematic.style.bladeHeightScaleMin < 0.8);
  assert.ok(refinement.cinematic.style.bladeHeightScaleMax > 1.2);
  assert.ok(refinement.cinematic.style.grassRootBrightness < 0.8);
});

test('tree LOD appearance has restrained deterministic variation tuning', () => {
  const appearance = refinement.trees.appearance;
  assert.ok(appearance.scaleVariation > 0 && appearance.scaleVariation <= 0.15);
  assert.ok(appearance.brightnessVariation > 0 && appearance.brightnessVariation <= 0.15);
  assert.ok(appearance.greenVariation > 0 && appearance.greenVariation <= 0.1);
  assert.ok(refinement.trees.billboard.fill > 0 && refinement.trees.billboard.fill < 0.15);
});

test('nearshore wave refinement bends fronts and varies spacing without changing the reference-axis travel', () => {
  const sea = resolveSeaWaves({
    enabled: true,
    level: -24,
    shoreX: 1000,
    depth: 95,
    detail: refinement.water.sea.detail,
  });
  const distance = 24;
  assert.equal(nearshoreWavePhase(1.25, distance, 0, sea), 1.25);

  const z = 140;
  const first = nearshoreWavePhase(1.25, distance, z, sea);
  const second = nearshoreWavePhase(1.25, distance * 2, z, sea);
  assert.notEqual(first, 1.25);
  const baseDelta = distance * Math.PI * 2 / sea.coast.wave.wavelength;
  assert.ok(Math.abs((second - first) - baseDelta) > 0.01);
});

test('upper beach transition is wider and contains more sparse detail opportunities', () => {
  const coast = refinement.water.sea.coast;
  assert.ok(coast.sand.inlandStart < -150);
  assert.ok(coast.sand.inlandEnd > -85);
  assert.ok(coast.vegetation.groundcoverEdge > 18);
  assert.ok(coast.scatter.attempts > 4500);
  assert.ok(coast.scatter.sizeMax > 0.19);
});
