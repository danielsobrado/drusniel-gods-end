const PREFIX = 'ambientEffects';
const SHAPES = new Set(['soft', 'glint', 'streak', 'firefly', 'fluff', 'shaft', 'puff']);
const REGIONS = new Set(['any', 'snow', 'sand', 'surf', 'jungle', 'water', 'lake', 'meadow']);
const NAMED_LEVELS = new Set(['sea', 'lake']);
const QUALITY_NAMES = ['performance', 'balanced', 'high', 'ultra'];
const DEFAULT_QUALITY = Object.freeze({ performance: 0.35, balanced: 0.6, high: 1, ultra: 1 });

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value, name, { min = -Infinity, max = Infinity, exclusiveMin = false } = {}) {
  const number = Number(value);
  const belowMin = exclusiveMin ? !(number > min) : number < min;
  if (value === null || value === undefined || !Number.isFinite(number) || belowMin || number > max) {
    throw new Error(`${name} must be a finite number in the configured range.`);
  }
  return number;
}

function range(value, name, { min = -Infinity } = {}) {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${name} must be a [min, max] pair.`);
  const low = finiteNumber(value[0], `${name}[0]`, { min });
  const high = finiteNumber(value[1], `${name}[1]`, { min });
  if (high < low) throw new Error(`${name}[1] must be greater than or equal to ${name}[0].`);
  return [low, high];
}

function presetWeights(value, name) {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${name} must map preset names to weights.`);
  return Object.fromEntries(Object.entries(value)
    .map(([preset, weight]) => [preset, finiteNumber(weight, `${name}.${preset}`, { min: 0, max: 4 })]));
}

// A level is a height in metres or the name of a water body.
function level(value, name, levels) {
  if (value === undefined || value === null) return null;
  if (NAMED_LEVELS.has(value)) {
    const resolved = levels[value];
    if (!Number.isFinite(resolved)) throw new Error(`${name} is "${value}", but that water body is not configured.`);
    return resolved;
  }
  return finiteNumber(value, name);
}

function resolveField(source, name, levels) {
  const path = `${PREFIX}.fields.${name}`;
  if (!isRecord(source)) throw new Error(`${path} must be an object.`);
  const shape = source.shape ?? 'soft';
  if (!SHAPES.has(shape)) throw new Error(`${path}.shape "${shape}" is not one of ${[...SHAPES].join(', ')}.`);
  const regions = [].concat(source.region ?? 'any');
  for (const region of regions) {
    if (!REGIONS.has(region)) throw new Error(`${path}.region "${region}" is not one of ${[...REGIONS].join(', ')}.`);
  }
  let base = source.base ?? 'ground';
  if (base !== 'ground' && base !== 'focus') base = level(base, `${path}.base`, levels);
  const lighting = source.lighting ?? 'sun';
  if (lighting !== 'sun' && lighting !== 'emissive') throw new Error(`${path}.lighting must be sun or emissive.`);
  const blending = source.blending ?? 'normal';
  if (blending !== 'normal' && blending !== 'additive') throw new Error(`${path}.blending must be normal or additive.`);
  const wind = source.wind ?? {};
  const windSource = wind.source ?? 'shared';
  if (windSource !== 'shared' && windSource !== 'snow') throw new Error(`${path}.wind.source must be shared or snow.`);
  const swarm = source.swarm ? {
    members: Math.round(finiteNumber(source.swarm.members, `${path}.swarm.members`, { min: 1, max: 256 })),
    radius: finiteNumber(source.swarm.radius, `${path}.swarm.radius`, { min: 0 }),
    frequency: finiteNumber(source.swarm.frequency ?? 3, `${path}.swarm.frequency`, { min: 0 }),
  } : null;
  const blink = source.blink ? {
    rate: finiteNumber(source.blink.rate, `${path}.blink.rate`, { min: 0, exclusiveMin: true }),
    sharpness: finiteNumber(source.blink.sharpness ?? 4, `${path}.blink.sharpness`, { min: 0 }),
  } : null;
  return {
    name,
    enabled: source.enabled !== false,
    regions,
    presets: presetWeights(source.presets, `${path}.presets`),
    presetDefault: finiteNumber(source.presetDefault ?? 1, `${path}.presetDefault`, { min: 0, max: 4 }),
    windResponse: finiteNumber(source.windResponse ?? 0, `${path}.windResponse`, { min: 0, max: 4 }),
    count: Math.round(finiteNumber(source.count, `${path}.count`, { min: 1, max: 20000 })),
    area: finiteNumber(source.area, `${path}.area`, { min: 0, exclusiveMin: true }),
    base,
    floor: level(source.floor, `${path}.floor`, levels),
    height: range(source.height ?? [0.5, 6], `${path}.height`),
    rise: finiteNumber(source.rise ?? 0, `${path}.rise`),
    wind: {
      source: windSource,
      speed: finiteNumber(wind.speed ?? 0, `${path}.wind.speed`, { min: 0 }),
      // How much of the preset's windiness scales the drift (0 = fixed speed).
      follow: finiteNumber(wind.follow ?? 1, `${path}.wind.follow`, { min: 0, max: 2 }),
    },
    wander: {
      radius: finiteNumber(source.wander?.radius ?? 0, `${path}.wander.radius`, { min: 0 }),
      frequency: finiteNumber(source.wander?.frequency ?? 0.3, `${path}.wander.frequency`, { min: 0 }),
    },
    swarm,
    hop: source.hop ? {
      length: finiteNumber(source.hop.length, `${path}.hop.length`, { min: 0, exclusiveMin: true }),
      rate: finiteNumber(source.hop.rate, `${path}.hop.rate`, { min: 0, exclusiveMin: true }),
      spread: finiteNumber(source.hop.spread ?? 15, `${path}.hop.spread`, { min: 0, max: 180 }),
    } : null,
    gusts: source.gusts ? {
      scale: finiteNumber(source.gusts.scale, `${path}.gusts.scale`, { min: 0, exclusiveMin: true }),
      threshold: finiteNumber(source.gusts.threshold ?? 0, `${path}.gusts.threshold`, { min: -1, max: 1 }),
      speed: finiteNumber(source.gusts.speed ?? 5, `${path}.gusts.speed`, { min: 0 }),
    } : null,
    size: range(source.size ?? [0.05, 0.1], `${path}.size`, { min: 0 }),
    stretch: finiteNumber(source.stretch ?? 6, `${path}.stretch`, { min: 1 }),
    length: finiteNumber(source.length ?? 20, `${path}.length`, { min: 0, exclusiveMin: true }),
    shape,
    color: typeof source.color === 'string' && source.color ? source.color : '#ffffff',
    toneVariation: finiteNumber(source.toneVariation ?? 0.1, `${path}.toneVariation`, { min: 0, max: 1 }),
    brightness: finiteNumber(source.brightness ?? 1, `${path}.brightness`, { min: 0, max: 8 }),
    opacity: finiteNumber(source.opacity ?? 1, `${path}.opacity`, { min: 0, max: 1 }),
    lighting,
    emissive: finiteNumber(source.emissive ?? 1, `${path}.emissive`, { min: 0, max: 64 }),
    scatter: finiteNumber(source.scatter ?? 1, `${path}.scatter`, { min: 0, max: 16 }),
    backlit: finiteNumber(source.backlit ?? 1, `${path}.backlit`, { min: 0, max: 1 }),
    blending,
    blink,
    twinkle: finiteNumber(source.twinkle ?? 0, `${path}.twinkle`, { min: 0 }),
    nearFade: finiteNumber(source.nearFade ?? 1, `${path}.nearFade`, { min: 0.01 }),
    soft: finiteNumber(source.soft ?? 0, `${path}.soft`, { min: 0 }),
  };
}

function resolveWeighted(source, name, defaults) {
  const path = `${PREFIX}.${name}`;
  const value = isRecord(source) ? source : {};
  return {
    enabled: value.enabled !== false,
    strength: finiteNumber(value.strength ?? defaults.strength, `${path}.strength`, { min: 0, max: 8 }),
    presets: presetWeights(value.presets, `${path}.presets`),
    presetDefault: finiteNumber(value.presetDefault ?? 1, `${path}.presetDefault`, { min: 0, max: 4 }),
    windResponse: finiteNumber(value.windResponse ?? defaults.windResponse ?? 0, `${path}.windResponse`, { min: 0, max: 4 }),
  };
}

/**
 * Resolves ambientEffects from the merged config: particle fields, ridge
 * plumes, breath, and the weights of the surface, fog and screen effects.
 * `levels` names the water heights a field may float on ({ sea, lake }).
 */
export function resolveAmbientEffectsConfig(config, levels = {}) {
  if (!isRecord(config) || config.enabled === false) return { enabled: false };
  const quality = { ...DEFAULT_QUALITY };
  for (const name of QUALITY_NAMES) {
    if (config.quality?.[name] !== undefined) {
      quality[name] = finiteNumber(config.quality[name], `${PREFIX}.quality.${name}`, { min: 0, max: 1 });
    }
  }
  const fields = Object.entries(config.fields ?? {})
    .map(([name, source]) => resolveField(source, name, levels))
    .filter((field) => field.enabled);
  const plumes = isRecord(config.plumes) && config.plumes.enabled !== false ? {
    ...resolveWeighted(config.plumes, 'plumes', { strength: 1, windResponse: 1 }),
    anchors: Math.round(finiteNumber(config.plumes.anchors ?? 18, `${PREFIX}.plumes.anchors`, { min: 1, max: 64 })),
    puffs: Math.round(finiteNumber(config.plumes.puffs ?? 12, `${PREFIX}.plumes.puffs`, { min: 1, max: 32 })),
    minHeight: finiteNumber(config.plumes.minHeight ?? 150, `${PREFIX}.plumes.minHeight`),
    step: finiteNumber(config.plumes.step ?? 20, `${PREFIX}.plumes.step`, { min: 1 }),
    prominenceRadius: finiteNumber(config.plumes.prominenceRadius ?? 60, `${PREFIX}.plumes.prominenceRadius`, { min: 1 }),
    minProminence: finiteNumber(config.plumes.minProminence ?? 8, `${PREFIX}.plumes.minProminence`, { min: 0 }),
    spacing: finiteNumber(config.plumes.spacing ?? 90, `${PREFIX}.plumes.spacing`, { min: 0 }),
    length: finiteNumber(config.plumes.length ?? 70, `${PREFIX}.plumes.length`, { min: 1 }),
    rise: finiteNumber(config.plumes.rise ?? 10, `${PREFIX}.plumes.rise`),
    size: range(config.plumes.size ?? [6, 30], `${PREFIX}.plumes.size`, { min: 0 }),
    lifetime: finiteNumber(config.plumes.lifetime ?? 9, `${PREFIX}.plumes.lifetime`, { min: 0.1 }),
    opacity: finiteNumber(config.plumes.opacity ?? 0.35, `${PREFIX}.plumes.opacity`, { min: 0, max: 1 }),
    brightness: finiteNumber(config.plumes.brightness ?? 1.8, `${PREFIX}.plumes.brightness`, { min: 0, max: 8 }),
  } : { enabled: false };
  const breath = isRecord(config.breath) && config.breath.enabled !== false ? {
    ...resolveWeighted(config.breath, 'breath', { strength: 1 }),
    period: finiteNumber(config.breath.period ?? 3.4, `${PREFIX}.breath.period`, { min: 0.2 }),
    runningPeriod: finiteNumber(config.breath.runningPeriod ?? 1.6, `${PREFIX}.breath.runningPeriod`, { min: 0.2 }),
    puffsPerBreath: Math.round(finiteNumber(config.breath.puffsPerBreath ?? 4, `${PREFIX}.breath.puffsPerBreath`, { min: 1, max: 12 })),
    lifetime: finiteNumber(config.breath.lifetime ?? 1.5, `${PREFIX}.breath.lifetime`, { min: 0.1 }),
    size: range(config.breath.size ?? [0.08, 0.45], `${PREFIX}.breath.size`, { min: 0 }),
    speed: finiteNumber(config.breath.speed ?? 0.7, `${PREFIX}.breath.speed`, { min: 0 }),
    opacity: finiteNumber(config.breath.opacity ?? 0.5, `${PREFIX}.breath.opacity`, { min: 0, max: 1 }),
    minSnow: finiteNumber(config.breath.minSnow ?? 0.35, `${PREFIX}.breath.minSnow`, { min: 0, max: 1 }),
  } : { enabled: false };
  return {
    enabled: true,
    fadeRate: finiteNumber(config.fadeRate ?? 0.8, `${PREFIX}.fadeRate`, { min: 0, exclusiveMin: true }),
    regionInterval: finiteNumber(config.regionInterval ?? 0.2, `${PREFIX}.regionInterval`, { min: 0 }),
    windReference: finiteNumber(config.windReference ?? 2.4, `${PREFIX}.windReference`, { min: 0, exclusiveMin: true }),
    gust: {
      strength: finiteNumber(config.gust?.strength ?? 0.4, `${PREFIX}.gust.strength`, { min: 0, max: 1 }),
      period: finiteNumber(config.gust?.period ?? 9, `${PREFIX}.gust.period`, { min: 0.1 }),
    },
    quality,
    fields,
    plumes,
    breath,
    snowStreaks: resolveWeighted(config.snowStreaks, 'snowStreaks', { strength: 1, windResponse: 1 }),
    sandStreaks: resolveWeighted(config.sandStreaks, 'sandStreaks', { strength: 1, windResponse: 1 }),
    grassGustSheen: resolveWeighted(config.grassGustSheen, 'grassGustSheen', { strength: 0.3 }),
    frost: resolveWeighted(config.frost, 'frost', { strength: 0.5 }),
    heatShimmer: resolveWeighted(config.heatShimmer, 'heatShimmer', { strength: 1 }),
    jungleMist: resolveJungleMistConfig(config),
  };
}

/**
 * The jungle mist alone, for the fog composition, which is built before the
 * water levels the particle fields need are known. Disabled with the whole
 * ambient layer.
 */
export function resolveJungleMistConfig(config) {
  if (!isRecord(config) || config.enabled === false) return { enabled: false };
  const source = config.jungleMist;
  const path = `${PREFIX}.jungleMist`;
  const nearStart = finiteNumber(source?.nearStart ?? 6, `${path}.nearStart`, { min: 0 });
  const nearEnd = finiteNumber(source?.nearEnd ?? 30, `${path}.nearEnd`, { min: 0 });
  if (nearEnd <= nearStart) throw new Error(`${path}.nearEnd must be greater than ${path}.nearStart.`);
  return {
    ...resolveWeighted(source, 'jungleMist', { strength: 1 }),
    density: finiteNumber(source?.density ?? 0.012, `${path}.density`, { min: 0 }),
    height: finiteNumber(source?.height ?? 6, `${path}.height`, { min: 0.1 }),
    maxDistance: finiteNumber(source?.maxDistance ?? 260, `${path}.maxDistance`, { min: 1 }),
    nearStart,
    nearEnd,
    pocketScale: finiteNumber(source?.pocketScale ?? 0.02, `${path}.pocketScale`, { min: 0 }),
    pocketStrength: finiteNumber(source?.pocketStrength ?? 0.55, `${path}.pocketStrength`, { min: 0, max: 1 }),
    color: typeof source?.color === 'string' ? source.color : '#c9d6c4',
  };
}

/** A preset's weight for an effect: its own entry, else the default. */
export function presetWeight(effect, presetName) {
  const weight = effect.presets?.[presetName];
  return Number.isFinite(weight) ? weight : effect.presetDefault ?? 1;
}

/**
 * Scales an effect by the preset wind: `windiness` is the preset's wind over
 * the reference breeze, `response` how strongly the effect follows it.
 */
export function windFactor(windiness, response) {
  if (!(response > 0)) return 1;
  return Math.min(Math.max(Number(windiness) || 0, 0), 2) ** response;
}
