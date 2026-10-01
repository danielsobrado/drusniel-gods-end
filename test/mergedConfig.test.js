import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { CONFIG_FILES, loadMergedConfig } from '../scripts/mergedConfig.mjs';
import { validateConfig } from '../src/config/validateConfig.js';

test('effective config uses the runtime YAML file order', async () => {
  assert.deepEqual(CONFIG_FILES, [
    'config.yaml',
    'ground-material.yaml',
    'surface-filtering.yaml',
    'player-controls.yaml',
    'scene.yaml',
    'audio.yaml',
    'tree-rendering.yaml',
    'character-visual.yaml',
    'cinematic-wind.yaml',
    'cinematic-look.yaml',
    'snow.yaml',
    'alpine.yaml',
    'vegetation.yaml',
    'foliage.yaml',
    'characters.yaml',
    'reference-biome.yaml',
    'coastal-jungle-runtime.yaml',
    'vegetation-lod.yaml',
    'ambient-effects.yaml',
    'surface-detail.yaml',
    'visual-refinement.yaml',
  ]);
});

test('cinematic wind is the effective runtime wind model', async () => {
  const config = await loadMergedConfig();
  const windFile = yaml.load(
    await readFile(new URL('../public/cinematic-wind.yaml', import.meta.url), 'utf8'),
  );
  assert.equal(config.wind.model, 'cinematic');
  assert.deepEqual(config.wind, windFile.wind);
});

test('base player motion values survive the merge', async () => {
  const config = await loadMergedConfig();
  assert.equal(config.player.motion.acceleration, 20);
  assert.equal(config.player.motion.deceleration, 16);
  assert.equal(config.player.motion.animationFadeSeconds, 0.25);
});

test('Warden visual scale survives later config layers', async () => {
  const config = await loadMergedConfig();
  assert.equal(config.player.modelScale, 1.35);
  assert.equal(config.player.targetHeight, 5.0);
});

test('tree billboards stay visible across high-altitude exploration views', async () => {
  const config = await loadMergedConfig();
  assert.equal(config.trees.highDistance, 170);
  assert.equal(config.trees.billboardDistance, 4000);
  assert.equal(config.trees.billboardHysteresis, 200);
  assert.equal(config.trees.lodUpdateInterval, 0.1);
  assert.equal(config.trees.billboard.alphaTest, 0.4);
  assert.equal(config.trees.billboard.anisotropy, 4);
  assert.ok(config.trees.billboardDistance < config.camera.far);
});

test('exploration config exposes snow, beach, lake and sea travel without breaking river continuity', async () => {
  const config = await loadMergedConfig();
  assert.deepEqual(
    config.navigation.locations.map(location => location.label),
    ['Start', 'River', 'Lake', 'Village', 'Beach South', 'Coastal Jungle', 'Beach North', 'Snow Pass', 'Alpine Summit', 'Snow Peak', 'Offshore', 'Deep Sea'],
  );
  assert.ok(config.navigation.scenicTour.riverViews[0].fraction < 0.05);
  assert.ok(config.navigation.scenicTour.riverViews.at(-1).fraction > 0.95);
  assert.equal(config.water.river.outletLevel, config.water.sea.level);
  assert.ok(config.water.river.points.at(-1)[2] > config.water.river.points[13][2]);
  const routes = config.terrain.expansion.routes;
  assert.ok(routes.some(route => route.name === 'Snow climb' && route.walkable));
  assert.ok(routes.some(route => route.name === 'Meadow south beach road' && route.walkable));
  assert.ok(routes.some(route => route.name === 'Foothill north beach trail' && route.walkable));
});

test('alpine snow config is loaded after the cinematic terrain defaults', async () => {
  const config = await loadMergedConfig();
  assert.equal(config.ground.snow.enabled, true);
  assert.deepEqual(config.ground.snow.altitude, { start: 84, full: 132 });
  assert.equal(config.ground.snow.deformation.resolution, 512);
  assert.equal(config.ground.snow.deformation.worldSize, 64);
  assert.equal(config.ground.snow.deformation.maxRadius, 0.56);
});

test('performance budget config rejects invalid culling and occlusion thresholds', async () => {
  const config = await loadMergedConfig();
  assert.doesNotThrow(() => validateConfig(structuredClone(config)));

  const badBudget = structuredClone(config);
  badBudget.vegetation.viewCulling.budgetMs = -1;
  assert.throws(() => validateConfig(badBudget), /vegetation\.viewCulling\.budgetMs/);

  const badShadowDistance = structuredClone(config);
  badShadowDistance.vegetationLod.update.shadowCastDistance = Number.NaN;
  assert.throws(() => validateConfig(badShadowDistance), /shadowCastDistance/);

  const badResolution = structuredClone(config);
  badResolution.cinematic.occlusion.resolutionScale = 0.1;
  assert.throws(() => validateConfig(badResolution), /cinematic\.occlusion\.resolutionScale/);

  const badEffectiveness = structuredClone(config);
  badEffectiveness.cinematic.occlusion.minSavedTrianglesPerMs = -1;
  assert.throws(() => validateConfig(badEffectiveness), /minSavedTrianglesPerMs/);
});

test('planar reflection cadence config rejects settings that can reintroduce capture spikes', async () => {
  const config = await loadMergedConfig();
  assert.doesNotThrow(() => validateConfig(structuredClone(config)));

  const zeroInterval = structuredClone(config);
  zeroInterval.cinematic.water.planarReflectionInterval = 0;
  assert.throws(() => validateConfig(zeroInterval), /planarReflectionInterval/);

  const stacked = structuredClone(config);
  stacked.cinematic.water.planarReflectionSurfaceGap = stacked.cinematic.water.planarReflectionInterval + 0.1;
  assert.throws(() => validateConfig(stacked), /planarReflectionSurfaceGap/);
});

test('character locomotion calibration is valid and rejects broken future character config', async () => {
  const config = await loadMergedConfig();
  assert.doesNotThrow(() => validateConfig(structuredClone(config)));

  const broken = structuredClone(config);
  broken.characters.roster[0].player.locomotion.rootMotion.axes = ['x', 'forward'];
  assert.throws(
    () => validateConfig(broken),
    /characters\.roster\[0\]\.player\.locomotion\.rootMotion\.axes/,
  );
});

test('character locomotion validation rejects ambiguous root-node names', async () => {
  const config = await loadMergedConfig();

  const whitespace = structuredClone(config);
  whitespace.characters.roster[0].player.locomotion.rootMotion.nodes = [' Hips '];
  assert.throws(
    () => validateConfig(whitespace),
    /rootMotion\.nodes must contain trimmed, non-empty node names/,
  );

  const duplicate = structuredClone(config);
  duplicate.characters.roster[0].player.locomotion.rootMotion.nodes = ['Hips', 'Hips'];
  assert.throws(
    () => validateConfig(duplicate),
    /rootMotion\.nodes must not contain duplicates/,
  );
});
