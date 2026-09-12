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
  ['navigation', 'WorldNavigation'],
  ['navigation.freeFly', 'FreeFlyController'],
  ['navigation.scenicTour', 'ScenicTour'],
];

function resolve(config, path) {
  let current = config;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function validateNavigation(config, problems) {
  const freeFly = config.navigation?.freeFly;
  for (const name of ['moveSpeed', 'fastMultiplier', 'lookSensitivity']) {
    const value = Number(freeFly?.[name]);
    if (!(value > 0) || !Number.isFinite(value)) {
      problems.push(`navigation.freeFly.${name} must be a positive finite number`);
    }
  }
  const minPitch = Number(freeFly?.minPitch);
  const maxPitch = Number(freeFly?.maxPitch);
  if (!Number.isFinite(minPitch) || !Number.isFinite(maxPitch) || minPitch >= maxPitch) {
    problems.push('navigation.freeFly pitch limits must be finite and minPitch must be lower than maxPitch');
  }

  const scenicTour = config.navigation?.scenicTour;
  for (const name of ['durationSeconds', 'returnDurationSeconds', 'lookAheadDistance', 'orientationSharpness']) {
    const value = Number(scenicTour?.[name]);
    if (!(value > 0) || !Number.isFinite(value)) {
      problems.push(`navigation.scenicTour.${name} must be a positive finite number`);
    }
  }
  const durationSeconds = Number(scenicTour?.durationSeconds);
  const returnDurationSeconds = Number(scenicTour?.returnDurationSeconds);
  if (Number.isFinite(durationSeconds) && Number.isFinite(returnDurationSeconds)
    && returnDurationSeconds >= durationSeconds) {
    problems.push('navigation.scenicTour.returnDurationSeconds must be lower than durationSeconds');
  }
  for (const name of ['terrainClearance', 'targetDrop', 'seaLookBlendStart', 'seaFocusHeightOffset']) {
    if (!Number.isFinite(Number(scenicTour?.[name]))) {
      problems.push(`navigation.scenicTour.${name} must be a finite number`);
    }
  }
  if (Number(scenicTour?.terrainClearance) < 0) {
    problems.push('navigation.scenicTour.terrainClearance must not be negative');
  }
  const seaLookBlendStart = Number(scenicTour?.seaLookBlendStart);
  if (Number.isFinite(seaLookBlendStart) && (seaLookBlendStart < 0 || seaLookBlendStart >= 1)) {
    problems.push('navigation.scenicTour.seaLookBlendStart must be in [0, 1)');
  }
  if (!Array.isArray(scenicTour?.seaFocusXZ) || scenicTour.seaFocusXZ.length !== 2
    || scenicTour.seaFocusXZ.some((value) => !Number.isFinite(Number(value)))) {
    problems.push('navigation.scenicTour.seaFocusXZ must contain two finite numbers');
  }

  const locations = config.navigation?.locations;
  if (!Array.isArray(locations) || locations.length === 0) {
    problems.push('navigation.locations must contain at least one destination');
    return;
  }

  const ids = new Set();
  for (const location of locations) {
    if (!location?.id || !location?.label) {
      problems.push('every navigation location requires id and label');
      continue;
    }
    if (ids.has(location.id)) problems.push(`navigation location id "${location.id}" is duplicated`);
    ids.add(location.id);
    if (!['ground', 'fly'].includes(location.mode)) {
      problems.push(`navigation location "${location.id}" has invalid mode "${location.mode}"`);
      continue;
    }
    const expectedLength = location.mode === 'fly' ? 3 : 2;
    if (!Array.isArray(location.position) || location.position.length !== expectedLength
      || location.position.some((value) => !Number.isFinite(Number(value)))) {
      problems.push(`navigation location "${location.id}" has an invalid position`);
    }
    if (location.target && (!Array.isArray(location.target) || location.target.length !== 3
      || location.target.some((value) => !Number.isFinite(Number(value))))) {
      problems.push(`navigation location "${location.id}" has an invalid target`);
    }
  }
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

  validateNavigation(config, problems);

  if (problems.length > 0) {
    throw new Error(
      `Merged configuration is invalid:\n  - ${problems.join('\n  - ')}\n`
      + 'Run `npm run config:dump` to inspect the merged result.',
    );
  }

  return config;
}
