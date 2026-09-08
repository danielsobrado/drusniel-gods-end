// Fails fast on a merged configuration that is missing a key the runtime
// dereferences without a guard, so a bad edit surfaces as a named error rather
// than a TypeError from deep inside a constructor.
//
// Scope is deliberately narrow: only keys read WITHOUT optional chaining or a
// `??` fallback. Optional assets are designed to fall back with a warning, and
// validating them would turn documented "continue with warnings" behavior into
// a hard startup failure.

import { grassFamily, isGrassShape } from '../grass/grassShapes.js';

const REQUIRED_OBJECTS = [
  ['camera', 'camera'],
  ['player', 'player'],
  ['terrain', 'terrain'],
  ['grass', 'GrassField'],
  ['grass.interaction', 'InteractionMap, PlayerController, DemoUi'],
  ['vegetation', 'ProceduralVegetationField, MeadowDetails'],
  ['vegetation.path', 'ProceduralVegetationField'],
  ['vegetation.terrain', 'ProceduralVegetationField'],
  ['vegetation.moisture', 'ProceduralVegetationField'],
  ['vegetation.trees', 'ProceduralVegetationField'],
  ['vegetation.density', 'ProceduralVegetationField'],
  ['vegetation.height', 'ProceduralVegetationField'],
  ['vegetation.understory', 'ProceduralVegetationField'],
  ['vegetation.details', 'MeadowDetails'],
  ['vegetation.noise', 'ProceduralVegetationField'],
  ['assets', 'asset loading'],
  ['assets.audio', 'AudioSystem'],
  ['assets.leaves', 'LeafSystem'],
  ['quality', 'GrassField, EnvironmentController'],
  ['presets', 'EnvironmentController'],
  ['ui', 'DemoUi'],
  ['renderer', 'createWorld'],
  ['world', 'createWorld'],
  ['sun', 'createWorld'],
  ['hemisphere', 'createWorld'],
  ['ambient', 'createWorld'],
];

function resolve(config, path) {
  let current = config;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function validateConfig(config) {
  const problems = [];

  if (!config || typeof config !== 'object') {
    throw new Error('Merged configuration is not an object.');
  }

  for (const [path, consumer] of REQUIRED_OBJECTS) {
    const value = resolve(config, path);
    if (value === null || typeof value !== 'object') {
      problems.push(`missing or non-object: ${path} (required by ${consumer})`);
    }
  }

  const initialQuality = config.ui?.initialQuality;
  if (initialQuality !== undefined && !config.quality?.[initialQuality]) {
    problems.push(`ui.initialQuality is "${initialQuality}", which is not a key of quality`);
  }

  const initialPreset = config.ui?.initialPreset;
  if (initialPreset !== undefined && !config.presets?.[initialPreset]) {
    problems.push(`ui.initialPreset is "${initialPreset}", which is not a key of presets`);
  }

  const shape = config.grass?.shape;
  if (shape !== undefined) {
    if (!isGrassShape(shape)) {
      problems.push(`grass.shape is "${shape}", which is not a known grass shape`);
    } else {
      const family = grassFamily(shape);
      if (typeof config.grass?.[family] !== 'object' || config.grass[family] === null) {
        problems.push(`grass.${family} is missing (required by grass.shape "${shape}")`);
      }
      for (const [name, profile] of Object.entries(config.quality ?? {})) {
        if (typeof profile?.[family] !== 'object' || profile[family] === null) {
          problems.push(`quality.${name}.${family} is missing (required by grass.shape "${shape}")`);
        }
      }
    }
  }

  for (const [name, profile] of Object.entries(config.quality ?? {})) {
    if (typeof profile?.fogMultiplier !== 'number') {
      problems.push(`quality.${name}.fogMultiplier is missing or not a number`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Merged configuration is invalid:\n  - ${problems.join('\n  - ')}\n`
      + 'Run `npm run config:dump` to inspect the merged result.',
    );
  }

  return config;
}
