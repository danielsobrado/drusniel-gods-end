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
    'player-controls.yaml',
    'visual-parity.yaml',
    'character-visual.yaml',
    'cinematic-wind.yaml',
    'painter-cursor.yaml',
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

