import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrassGeometry } from '../src/grass/GrassGeometry.js';
import {
  DEFAULT_GRASS_SHAPE,
  GRASS_SHAPES,
  grassFamily,
  grassShapeProfile,
  isGrassShape,
  resolveGrassShape,
} from '../src/grass/grassShapes.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

const config = await loadMergedConfig();

test('legacy billboard configs keep their render family unless a shape overrides it', () => {
  assert.equal(resolveGrassShape({ type: 'billboard' }), 'tufted');
  assert.equal(resolveGrassShape({ type: 'blade' }), 'slender');
  assert.equal(resolveGrassShape({ type: 'billboard', shape: 'reed' }), 'reed');
});

// A shape borrows its family's config blocks. GrassField, GrassGeometryFactory,
// GrassMaterial and WindField all index those without a guard, so a shape whose
// family is missing anywhere crashes deep inside a constructor at startup.
test('every shape family has the config blocks its consumers dereference', () => {
  for (const [name, shape] of Object.entries(GRASS_SHAPES)) {
    const family = shape.family;
    assert.equal(typeof config.grass[family], 'object', `grass.${family} for shape ${name}`);
    assert.equal(
      typeof config.wind.response[family],
      'object',
      `wind.response.${family} for shape ${name}`,
    );
    for (const tier of Object.keys(config.quality)) {
      assert.equal(
        typeof config.quality[tier][family],
        'object',
        `quality.${tier}.${family} for shape ${name}`,
      );
    }
    for (const preset of Object.keys(config.presets)) {
      assert.equal(
        typeof config.presets[preset].grass[family],
        'object',
        `presets.${preset}.grass.${family} for shape ${name}`,
      );
    }
  }
});

test('config.grass.shape names a real shape', () => {
  assert.ok(isGrassShape(config.grass.shape), `grass.shape "${config.grass.shape}" is unknown`);
});

test('an unknown shape falls back to the default rather than throwing', () => {
  assert.equal(isGrassShape('nonesuch'), false);
  assert.equal(grassFamily('nonesuch'), GRASS_SHAPES[DEFAULT_GRASS_SHAPE].family);
  assert.equal(grassShapeProfile('nonesuch'), grassShapeProfile(DEFAULT_GRASS_SHAPE));
});

test('blade profiles start with width and taper to a point', () => {
  for (const [name, shape] of Object.entries(GRASS_SHAPES)) {
    if (shape.family !== 'blade') continue;
    const { width } = grassShapeProfile(name);
    assert.ok(width(0) > 0, `${name} must have width at the base`);
    assert.equal(width(1), 0, `${name} must close to a point at the tip`);
    for (let r = 0; r <= 1; r += 0.1) {
      assert.ok(Number.isFinite(width(r)) && width(r) >= 0, `${name} width at ${r}`);
    }
  }
});

// Every blade shape draws the same vertex count, so the only cost that varies
// between them is covered pixels: the integral of width(r) * widthScale. This
// caught broadleaf shipping at 2.51x slender's fill, which cost 44% frame time
// at an identical triangle count.
test('no blade shape costs much more fill than the default', () => {
  const area = (name) => {
    const { width, widthScale } = grassShapeProfile(name);
    const steps = 2000;
    let sum = 0;
    for (let i = 0; i < steps; i += 1) sum += width((i + 0.5) / steps) / steps;
    return sum * widthScale;
  };

  const slender = area(DEFAULT_GRASS_SHAPE);
  for (const [name, shape] of Object.entries(GRASS_SHAPES)) {
    if (shape.family !== 'blade') continue;
    const ratio = area(name) / slender;
    assert.ok(ratio <= 1.35, `${name} covers ${ratio.toFixed(2)}x the pixels of ${DEFAULT_GRASS_SHAPE}`);
  }
});

// Each blade shape must actually produce a different silhouette, or the picker
// offers four names for two looks.
test('blade shapes generate distinguishable geometry', () => {
  const build = (shape) => createGrassGeometry({
    type: 'blade',
    shape,
    detail: 5,
    density: 1,
    tileSize: 4,
    bladeHeight: 1.5,
    stable: true,
  }).getAttribute('position').array;

  const slender = build('slender');
  const reed = build('reed');
  const broadleaf = build('broadleaf');

  assert.equal(slender.length, reed.length, 'same detail must give the same vertex count');
  assert.notDeepEqual(Array.from(slender), Array.from(reed));
  assert.notDeepEqual(Array.from(slender), Array.from(broadleaf));
  assert.notDeepEqual(Array.from(reed), Array.from(broadleaf));
});
