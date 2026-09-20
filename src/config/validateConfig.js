import { validateVegetationLodConfig } from './validateVegetationLodConfig.js';
// Fails fast on a merged configuration that is missing a key the runtime
// dereferences without a guard, so a bad edit surfaces as a named error rather
// than a TypeError from deep inside a constructor.
//
// Scope is deliberately narrow: only keys read WITHOUT optional chaining or a
// `??` fallback. Optional assets are designed to fall back with a warning, and
// validating them would turn documented "continue with warnings" behavior into
// a hard startup failure.

import { grassFamily, isGrassShape } from '../grass/grassShapes.js';
import { validateGrassQualityLod } from '../grass/grassLodPolicy.js';

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
  ['trees', 'TreeSystem'],
  ['trees.billboard', 'TreeSystem'],
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

function isFinitePair(value) {
  return Array.isArray(value) && value.length === 2
    && value.every((item) => Number.isFinite(Number(item)));
}

function validateTrees(config, problems) {
  const trees = config.trees;
  for (const name of ['highDistance', 'billboardDistance', 'transitionDuration', 'lodUpdateInterval']) {
    const value = Number(trees?.[name]);
    if (!(value > 0) || !Number.isFinite(value)) {
      problems.push(`trees.${name} must be a positive finite number`);
    }
  }
  for (const name of ['highHysteresis', 'billboardHysteresis']) {
    const value = Number(trees?.[name]);
    if (!(value >= 0) || !Number.isFinite(value)) {
      problems.push(`trees.${name} must be a non-negative finite number`);
    }
  }
  const highDistance = Number(trees?.highDistance);
  const billboardDistance = Number(trees?.billboardDistance);
  if (Number.isFinite(highDistance) && Number.isFinite(billboardDistance)
    && billboardDistance <= highDistance) {
    problems.push('trees.billboardDistance must be greater than trees.highDistance');
  }

  const alphaTest = Number(trees?.billboard?.alphaTest);
  if (!Number.isFinite(alphaTest) || alphaTest < 0 || alphaTest > 1) {
    problems.push('trees.billboard.alphaTest must be a finite number in [0, 1]');
  }
  const anisotropy = Number(trees?.billboard?.anisotropy);
  if (!(anisotropy >= 1) || !Number.isFinite(anisotropy)) {
    problems.push('trees.billboard.anisotropy must be a finite number greater than or equal to one');
  }
}

function validateScenicRiverViews(scenicTour, problems) {
  const views = scenicTour?.riverViews;
  if (!Array.isArray(views) || views.length < 2) {
    problems.push('navigation.scenicTour.riverViews must contain at least two views');
    return;
  }
  let previousFraction = -1;
  for (let index = 0; index < views.length; index += 1) {
    const view = views[index];
    const fraction = Number(view?.fraction);
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1 || fraction <= previousFraction) {
      problems.push('navigation.scenicTour.riverViews fractions must be strictly increasing in [0, 1]');
      break;
    }
    previousFraction = fraction;
    if (!Number.isFinite(Number(view?.offset))) {
      problems.push(`navigation.scenicTour.riverViews[${index}].offset must be finite`);
    }
    const lift = Number(view?.lift);
    if (!(lift > 0) || !Number.isFinite(lift)) {
      problems.push(`navigation.scenicTour.riverViews[${index}].lift must be a positive finite number`);
    }
  }
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
  if (!isFinitePair(scenicTour?.seaFocusXZ)) {
    problems.push('navigation.scenicTour.seaFocusXZ must contain two finite numbers');
  }
  validateScenicRiverViews(scenicTour, problems);

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

function validateLandscapeTravel(config, problems) {
  const expansion = config.terrain?.expansion;
  if (expansion?.enabled && expansion.routes !== undefined) {
    if (!Array.isArray(expansion.routes)) {
      problems.push('terrain.expansion.routes must be an array');
    } else {
      for (let index = 0; index < expansion.routes.length; index += 1) {
        const route = expansion.routes[index];
        const prefix = `terrain.expansion.routes[${index}]`;
        if (!route?.name) problems.push(`${prefix}.name is required`);
        if (!(Number(route?.width) > 0) || !Number.isFinite(Number(route?.width))) {
          problems.push(`${prefix}.width must be a positive finite number`);
        }
        if (!Array.isArray(route?.points) || route.points.length < 2 || !route.points.every(isFinitePair)) {
          problems.push(`${prefix}.points must contain at least two finite X/Z pairs`);
        }
        if (route?.walkable) {
          const terrainWidth = Number(route.terrainWidth);
          if (!(terrainWidth > Number(route.width)) || !Number.isFinite(terrainWidth)) {
            problems.push(`${prefix}.terrainWidth must be greater than its route width`);
          }
          const maxGrade = Number(route.maxGrade);
          if (!(maxGrade > 0) || !Number.isFinite(maxGrade)) {
            problems.push(`${prefix}.maxGrade must be a positive finite number`);
          }
        }
      }
    }
  }

  const river = config.water?.river;
  if (!river?.enabled || river.outletStartIndex === undefined) return;
  if (!Array.isArray(river.points) || river.points.length < 3) {
    problems.push('water.river.points must contain at least three points for an outlet');
    return;
  }
  const outletStartIndex = Number(river.outletStartIndex);
  if (!Number.isInteger(outletStartIndex) || outletStartIndex <= 0 || outletStartIndex >= river.points.length - 1) {
    problems.push('water.river.outletStartIndex must reference an interior control point');
  }
  const outletLevel = Number(river.outletLevel);
  if (!Number.isFinite(outletLevel)) problems.push('water.river.outletLevel must be finite');
  const lakeLevel = Number(config.water?.position?.[1]);
  if (Number.isFinite(outletLevel) && Number.isFinite(lakeLevel) && outletLevel >= lakeLevel) {
    problems.push('water.river.outletLevel must be below the lake level');
  }
  for (const name of ['outletBankBlend', 'outletDepth', 'mouthDepth']) {
    const value = Number(river[name]);
    if (!(value > 0) || !Number.isFinite(value)) {
      problems.push(`water.river.${name} must be a positive finite number`);
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

  validateGrassQualityLod(config, problems);
  validateTrees(config, problems);
  validateVegetationLodConfig(config, problems);
  validateNavigation(config, problems);
  validateLandscapeTravel(config, problems);

  if (problems.length > 0) {
    throw new Error(
      `Merged configuration is invalid:\n  - ${problems.join('\n  - ')}\n`
      + 'Run `npm run config:dump` to inspect the merged result.',
    );
  }

  return config;
}
