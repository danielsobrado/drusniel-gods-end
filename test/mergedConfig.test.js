import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { CONFIG_FILES, loadMergedConfig } from '../scripts/mergedConfig.mjs';

function* leaves(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    yield [prefix, value];
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    yield* leaves(child, prefix ? `${prefix}.${key}` : key);
  }
}

function resolve(root, dottedPath) {
  return dottedPath.split('.').reduce((acc, seg) => (acc == null ? acc : acc[seg]), root);
}

test('effective config uses the runtime YAML file order', async () => {
  assert.deepEqual(CONFIG_FILES, [
    'config.yaml',
    'ground-material.yaml',
    'surface-filtering.yaml',
    'player-controls.yaml',
    'visual-parity.yaml',
    'tree-rendering.yaml',
    'character-visual.yaml',
    'cinematic-wind.yaml',
    'cinematic-look.yaml',
    'snow.yaml',
    'alpine.yaml',
    'painter-cursor.yaml',
    'vegetation.yaml',
    'foliage.yaml',
    'characters.yaml',
    'reference-biome.yaml',
    'coastal-jungle-runtime.yaml',
    'vegetation-lod.yaml',
    'visual-refinement.yaml',
  ]);

  const config = await loadMergedConfig();
  const cursorFile = yaml.load(
    await readFile(new URL('../public/painter-cursor.yaml', import.meta.url), 'utf8'),
  );
  const painterLeaves = [...leaves(cursorFile.painter)];
  assert.ok(
    painterLeaves.length >= 15,
    `expected a substantial painter block, got ${painterLeaves.length} leaves`,
  );

  for (const [dottedPath, expected] of painterLeaves) {
    assert.deepEqual(
      resolve(config.painter, dottedPath),
      expected,
      `painter.${dottedPath} should come from painter-cursor.yaml`,
    );
  }
});

test('cinematic wind is the effective runtime wind model', async () => {
  const config = await loadMergedConfig();
  const windFile = yaml.load(
    await readFile(new URL('../public/cinematic-wind.yaml', import.meta.url), 'utf8'),
  );
  assert.equal(config.wind.model, 'cinematic');
  assert.deepEqual(config.wind, windFile.wind);
});

test('recovered player motion values survive the merge', async () => {
  const config = await loadMergedConfig();
  assert.equal(config.player.motion.acceleration, 20);
  assert.equal(config.player.motion.deceleration, 16);
  assert.equal(config.player.motion.animationFadeSeconds, 0.25);
});

test('Warden visual scale survives later parity layers', async () => {
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
    ['Start', 'River', 'Lake', 'Beach South', 'Coastal Jungle', 'Beach North', 'Snow Pass', 'Alpine Summit', 'Snow Peak', 'Offshore', 'Deep Sea'],
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
