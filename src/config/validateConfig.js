import { validateVegetationLodConfig } from './validateVegetationLodConfig.js';
import { validateWorldScaleConfig } from '../world/worldScale.js';
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
  ['audio', 'AudioSystem'],
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
  const finalHoldSeconds = Number(scenicTour?.finalHoldSeconds ?? 0);
  if (!Number.isFinite(finalHoldSeconds) || finalHoldSeconds < 0) {
    problems.push('navigation.scenicTour.finalHoldSeconds must be a non-negative finite number');
  }
  if (Number.isFinite(durationSeconds) && Number.isFinite(returnDurationSeconds)
    && returnDurationSeconds >= durationSeconds) {
    problems.push('navigation.scenicTour.returnDurationSeconds must be lower than durationSeconds');
  }
  if (Number.isFinite(durationSeconds) && Number.isFinite(returnDurationSeconds)
    && Number.isFinite(finalHoldSeconds)
    && returnDurationSeconds + finalHoldSeconds >= durationSeconds) {
    problems.push('navigation.scenicTour return and hold durations must leave time for travel');
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
  const preloadDistance = Number(scenicTour?.preloadDistance ?? 0);
  if (!Number.isFinite(preloadDistance) || preloadDistance < 0) {
    problems.push('navigation.scenicTour.preloadDistance must be a non-negative finite number');
  }

  if (scenicTour?.showcasePoints !== undefined) {
    if (!Array.isArray(scenicTour.showcasePoints) || scenicTour.showcasePoints.length < 2) {
      problems.push('navigation.scenicTour.showcasePoints must contain at least two points');
    } else {
      for (let index = 0; index < scenicTour.showcasePoints.length; index += 1) {
        const point = scenicTour.showcasePoints[index];
        const prefix = `navigation.scenicTour.showcasePoints[${index}]`;
        // A serpent point is placed from the live snake instead of a position.
        if (point?.serpent !== undefined) {
          if (!Number.isInteger(point.serpent) || point.serpent < 0 || point.serpent >= (config.wildlife?.serpents?.length ?? 0)) {
            problems.push(`${prefix}.serpent must be a wildlife.serpents index`);
          }
        } else if (!isFinitePair(point?.position)) problems.push(`${prefix}.position must contain finite X/Z values`);
        for (const name of ['pace', 'paceRadius', 'lookRadius', 'standoff']) {
          const value = point?.[name];
          if (value !== undefined && !(Number(value) > 0 && Number.isFinite(Number(value)))) {
            problems.push(`${prefix}.${name} must be a positive finite number when provided`);
          }
        }
        if (point?.lookAt !== undefined && !(Array.isArray(point.lookAt) && [2, 3].includes(point.lookAt.length)
          && point.lookAt.every((value) => Number.isFinite(Number(value))))) {
          problems.push(`${prefix}.lookAt must contain finite [x, z] or [x, y, z] values`);
        }
        const lift = Number(point?.lift);
        if (!(lift > 0) || !Number.isFinite(lift)) problems.push(`${prefix}.lift must be a positive finite number`);
        if (point?.minY !== undefined && !Number.isFinite(Number(point.minY))) {
          problems.push(`${prefix}.minY must be finite when provided`);
        }
      }
    }
  }

  const lakeDive = scenicTour?.lakeDive;
  if (lakeDive?.enabled) {
    if (!isFinitePair(lakeDive.centerXZ)) {
      problems.push('navigation.scenicTour.lakeDive.centerXZ must contain two finite numbers');
    }
    for (const name of ['radius', 'depth']) {
      const value = Number(lakeDive[name]);
      if (!(value > 0) || !Number.isFinite(value)) {
        problems.push(`navigation.scenicTour.lakeDive.${name} must be a positive finite number`);
      }
    }
    for (const name of ['fullDepthRadius', 'bedClearance']) {
      const value = Number(lakeDive[name]);
      if (!(value >= 0) || !Number.isFinite(value)) {
        problems.push(`navigation.scenicTour.lakeDive.${name} must be a non-negative finite number`);
      }
    }
    if (Number.isFinite(Number(lakeDive.fullDepthRadius))
      && Number.isFinite(Number(lakeDive.radius))
      && Number(lakeDive.fullDepthRadius) >= Number(lakeDive.radius)) {
      problems.push('navigation.scenicTour.lakeDive.fullDepthRadius must be lower than radius');
    }
  }

  if (!Array.isArray(scenicTour?.showcasePoints) || scenicTour.showcasePoints.length === 0) {
    validateScenicRiverViews(scenicTour, problems);
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

function validateCharacterLocomotion(config, problems) {
  const roster = config.characters?.roster;
  if (roster === undefined) return;
  if (!Array.isArray(roster)) {
    problems.push('characters.roster must be an array');
    return;
  }

  const allowedAxes = new Set(['x', 'y', 'z']);
  for (let index = 0; index < roster.length; index += 1) {
    const locomotion = roster[index]?.player?.locomotion;
    if (locomotion === undefined) continue;
    const prefix = `characters.roster[${index}].player.locomotion`;

    if (locomotion === null || typeof locomotion !== 'object' || Array.isArray(locomotion)) {
      problems.push(`${prefix} must be an object`);
      continue;
    }

    if (locomotion.footPlacement !== undefined && typeof locomotion.footPlacement !== 'boolean') {
      problems.push(`${prefix}.footPlacement must be boolean`);
    }

    const rootMotion = locomotion.rootMotion;
    if (rootMotion !== undefined) {
      if (rootMotion === null || typeof rootMotion !== 'object' || Array.isArray(rootMotion)) {
        problems.push(`${prefix}.rootMotion must be an object`);
      } else {
        if (rootMotion.inPlace !== undefined && typeof rootMotion.inPlace !== 'boolean') {
          problems.push(`${prefix}.rootMotion.inPlace must be boolean`);
        }

        if (rootMotion.inPlace) {
          if (!Array.isArray(rootMotion.nodes) || rootMotion.nodes.length === 0
            || rootMotion.nodes.some((node) => (
              typeof node !== 'string' || node.trim() === '' || node !== node.trim()
            ))) {
            problems.push(`${prefix}.rootMotion.nodes must contain trimmed, non-empty node names`);
          } else if (new Set(rootMotion.nodes).size !== rootMotion.nodes.length) {
            problems.push(`${prefix}.rootMotion.nodes must not contain duplicates`);
          }
        }

        if (rootMotion.axes !== undefined) {
          if (!Array.isArray(rootMotion.axes) || rootMotion.axes.length === 0
            || rootMotion.axes.some((axis) => !allowedAxes.has(axis))) {
            problems.push(`${prefix}.rootMotion.axes must contain only x, y or z`);
          } else if (new Set(rootMotion.axes).size !== rootMotion.axes.length) {
            problems.push(`${prefix}.rootMotion.axes must not contain duplicates`);
          }
        }
      }
    }

    const clipSpeeds = locomotion.clipSpeedInHeights;
    if (clipSpeeds !== undefined) {
      if (clipSpeeds === null || typeof clipSpeeds !== 'object' || Array.isArray(clipSpeeds)) {
        problems.push(`${prefix}.clipSpeedInHeights must be an object`);
      } else {
        for (const kind of ['walk', 'run']) {
          if (clipSpeeds[kind] === undefined) continue;
          const speed = Number(clipSpeeds[kind]);
          if (!(speed > 0) || !Number.isFinite(speed)) {
            problems.push(`${prefix}.clipSpeedInHeights.${kind} must be a positive finite number`);
          }
        }
      }
    }
  }
}

function validateTerrainStreaming(config, problems) {
  const settings = config.assets?.terrainStreaming;
  if (!settings?.enabled) return;

  const groups = settings.groups;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) {
    problems.push('assets.terrainStreaming.groups must be an object');
    return;
  }

  const knownParts = new Set((config.assets?.terrainParts ?? []).flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (!entry || typeof entry !== 'object') return [];
    if (typeof entry.name === 'string') return [entry.name];
    return Object.keys(entry).slice(0, 1);
  }));

  const claimed = new Set();
  for (const [name, group] of Object.entries(groups)) {
    const prefix = `assets.terrainStreaming.groups.${name}`;
    if (!Array.isArray(group?.parts) || group.parts.length === 0) {
      problems.push(`${prefix}.parts must contain at least one terrain part name`);
    } else {
      for (const part of group.parts) {
        if (typeof part !== 'string' || !knownParts.has(part)) {
          problems.push(`${prefix}.parts contains unknown terrain part "${part}"`);
        }
        if (claimed.has(part)) problems.push(`terrain stream part "${part}" belongs to more than one group`);
        claimed.add(part);
      }
    }
    if (!isFinitePair(group?.center)) problems.push(`${prefix}.center must contain two finite numbers`);
    for (const key of ['radius', 'preloadDistance']) {
      const value = Number(group?.[key]);
      if (!(value >= 0) || !Number.isFinite(value)) {
        problems.push(`${prefix}.${key} must be a non-negative finite number`);
      }
    }
  }
}

function validateMobileStartup(config, problems) {
  const settings = config.ui?.mobileStartup;
  if (!settings?.enabled) return;

  if (!(Number(settings.maxShortSide) > 0)) {
    problems.push('ui.mobileStartup.maxShortSide must be a positive number');
  }
  if (settings.requireCoarsePointer !== undefined && typeof settings.requireCoarsePointer !== 'boolean') {
    problems.push('ui.mobileStartup.requireCoarsePointer must be boolean');
  }
  if (!config.quality?.[settings.initialQuality]) {
    problems.push('ui.mobileStartup.initialQuality must name a configured quality tier');
  }
  if (!(Number(settings.pixelRatioCap) > 0)) {
    problems.push('ui.mobileStartup.pixelRatioCap must be a positive number');
  }
  if (!(Number(settings.warmupTravelDistance) > 0)) {
    problems.push('ui.mobileStartup.warmupTravelDistance must be a positive number');
  }
}

function validateCinematicOcclusion(config, problems) {
  const occlusion = config.cinematic?.occlusion;
  if (!occlusion) return;

  if (occlusion.resolutionScale !== undefined) {
    const resolutionScale = Number(occlusion.resolutionScale);
    if (!(resolutionScale >= 0.125 && resolutionScale <= 1) || !Number.isFinite(resolutionScale)) {
      problems.push('cinematic.occlusion.resolutionScale must be a finite number in [0.125, 1]');
    }
  }
  if (occlusion.minSavedTrianglesPerMs !== undefined) {
    const minSavedTrianglesPerMs = Number(occlusion.minSavedTrianglesPerMs);
    if (!(minSavedTrianglesPerMs >= 0) || !Number.isFinite(minSavedTrianglesPerMs)) {
      problems.push('cinematic.occlusion.minSavedTrianglesPerMs must be a non-negative finite number');
    }
  }
}

function validateCinematicWater(config, problems) {
  const water = config.cinematic?.water;
  if (!water) return;

  const interval = water.planarReflectionInterval === undefined
    ? 0.25 : Number(water.planarReflectionInterval);
  if (water.planarReflectionInterval !== undefined
    && (!(interval > 0) || !Number.isFinite(interval))) {
    problems.push('cinematic.water.planarReflectionInterval must be a positive finite number');
  }

  const gap = water.planarReflectionSurfaceGap === undefined
    ? 0.05 : Number(water.planarReflectionSurfaceGap);
  if (water.planarReflectionSurfaceGap !== undefined
    && (!(gap >= 0) || !Number.isFinite(gap))) {
    problems.push('cinematic.water.planarReflectionSurfaceGap must be a non-negative finite number');
  } else if (Number.isFinite(interval) && interval > 0 && Number.isFinite(gap) && gap > interval) {
    problems.push('cinematic.water.planarReflectionSurfaceGap must not exceed planarReflectionInterval');
  }

  const overscan = water.planarReflectionOverscan;
  if (overscan !== undefined) {
    const values = Array.isArray(overscan) ? overscan : [overscan];
    if (values.length < 1 || values.length > 2
      || !values.every(value => Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 2)) {
      problems.push('cinematic.water.planarReflectionOverscan must be a number or [x, y] pair between 1 and 2');
    }
  }

  const underwater = water.underwaterPerformance;
  if (!underwater) return;
  const nonNegative = [
    'hysteresis',
    'reflectionCutoffDepth',
    'seaLodDepth',
    'terrain3dLodDepth',
    'vegetationCullDepth',
    'atmosphereCullDepth',
    'shadowCullDepth',
  ];
  for (const name of nonNegative) {
    if (underwater[name] === undefined) continue;
    const value = Number(underwater[name]);
    if (!Number.isFinite(value) || value < 0) {
      problems.push(`cinematic.water.underwaterPerformance.${name} must be a non-negative finite number`);
    }
  }
  if (underwater.seaQuality !== undefined
    && !['performance', 'balanced', 'high', 'ultra'].includes(underwater.seaQuality)) {
    problems.push('cinematic.water.underwaterPerformance.seaQuality must be a known quality tier');
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
    const shadowMapSize = Number(profile?.shadowMapSize);
    if (!(shadowMapSize > 0) || !Number.isFinite(shadowMapSize)) {
      problems.push(`quality.${name}.shadowMapSize must be a positive finite number`);
    }
  }

  validateGrassQualityLod(config, problems);
  validateCharacterLocomotion(config, problems);
  validateTerrainStreaming(config, problems);
  validateMobileStartup(config, problems);
  validateCinematicOcclusion(config, problems);
  validateCinematicWater(config, problems);
  validateTrees(config, problems);
  validateVegetationLodConfig(config, problems);
  validateWorldScaleConfig(config, problems);
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
