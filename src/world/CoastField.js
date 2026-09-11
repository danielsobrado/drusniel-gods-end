import { MathUtils } from 'three';
import { Fn, cos, float, sin } from 'three/tsl';

const TAU = Math.PI * 2;

export const DEFAULT_COAST = Object.freeze({
  curve: Object.freeze({
    longFrequency: 0.005,
    longAmplitude: 65,
    shortFrequency: 0.014,
    shortAmplitude: 18,
  }),
  terrain: Object.freeze({
    inlandBlendStart: -230,
    beachTop: -90,
    beachHeight: 9,
    shelfKnee: 80,
    shelfKneeDepth: 9,
    shelfEnd: 500,
  }),
  wave: Object.freeze({
    wavelength: 13,
    speed: 1.35,
    bendFrequency: 0.085,
    bend: 0.32,
  }),
  swash: Object.freeze({
    reach: 12,
    seawardStart: 1.5,
    frontWidth: 1.2,
    foamWidth: 1.6,
    foamCore: 0.18,
    breakupFrequency: 0.13,
    breakupStrength: 0.28,
  }),
  moisture: Object.freeze({
    baseReach: 32,
    baseStrength: 0.55,
    washDecay: 4,
    rainWashDecay: 2,
    wettingSeconds: 18,
    dryingSeconds: 100,
  }),
  sand: Object.freeze({
    dryDark: '#b39a72',
    dryLight: '#d6be96',
    dryRoughness: 0.97,
    wetRoughness: 0.24,
    wetDarkening: 0.55,
    rippleFrequency: 1.4,
    rippleCrossFrequency: 0.52,
    rippleStrength: 0.025,
    grainFrequencyX: 31,
    grainFrequencyZ: 27,
    grainStrength: 0.018,
    grainFadeStart: 8,
    grainFadeEnd: 60,
    mesoFrequencyX: 0.73,
    mesoFrequencyZ: 1.27,
    mesoWetMin: 0.8,
    mesoWetMax: 1.15,
    mesoToneMin: 0.84,
    mesoToneMax: 1.04,
    macroFrequency: 0.037,
    inlandStart: -150,
    inlandEnd: -85,
    baseMoistureStrength: 1,
    washMemoryStrength: 0.55,
    rainMoistureStrength: 0.8,
    coverageWetness: 0.85,
    filmTint: '#8ccad0',
    filmTintStrength: 0.18,
    filmRoughness: 0.08,
    foamColor: '#edf8fb',
    foamStrength: 0.92,
    foamRoughness: 0.72,
    normalFrequencyX: 18.7,
    normalFrequencyZ: 21.3,
    normalStrength: 0.025,
    wetNormalFlattening: 0.7,
    filmNormalFlattening: 0.9,
  }),
  vegetation: Object.freeze({
    grassStart: 45,
    grassEnd: 140,
    groundcoverStart: 55,
    groundcoverEnd: 145,
    groundcoverEdge: 18,
    maxSlope: 0.35,
    seed: 73121,
    maxPatches: 500,
    minClumps: 1,
    maxClumps: 3,
    sizeMin: 0.22,
    sizeMax: 0.62,
    color: '#667957',
    qualityPerformance: 0.35,
    qualityBalanced: 0.6,
    qualityHigh: 0.85,
    qualityUltra: 1,
  }),
  scatter: Object.freeze({
    seed: 58103,
    attempts: 4500,
    inlandMin: 22,
    inlandMax: 117,
    edge: 18,
    density: 0.3,
    minNormalY: 0.9,
    sizeMin: 0.06,
    sizeMax: 0.19,
    pebbleColor: '#625c4e',
    shellColor: '#c9bea2',
    twigColor: '#655341',
    roughness: 0.94,
  }),
});

const RESOLVED = Symbol('resolvedCoast');
const cache = new WeakMap();

function mergeGroup(name, source) {
  return { ...DEFAULT_COAST[name], ...(source?.[name] ?? {}) };
}

function assertFiniteGroup(name, value) {
  const defaults = DEFAULT_COAST[name];
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (typeof defaultValue !== 'number') continue;
    if (!Number.isFinite(value[key])) {
      throw new Error(`water.sea.coast.${name}.${key} must be a finite number.`);
    }
  }
}

function assertPositive(path, value, allowZero = false) {
  if (value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${path} must be ${allowZero ? 'non-negative' : 'greater than zero'}.`);
  }
}

export function resolveCoastConfig(sea = {}) {
  if (sea?.[RESOLVED]) return sea;
  if (sea && typeof sea === 'object' && cache.has(sea)) return cache.get(sea);

  const coastSource = sea?.coast ?? {};
  const coast = {};
  for (const name of Object.keys(DEFAULT_COAST)) {
    coast[name] = mergeGroup(name, coastSource);
    assertFiniteGroup(name, coast[name]);
  }

  const { terrain, wave, swash, moisture, sand, vegetation, scatter } = coast;
  if (!(terrain.inlandBlendStart < terrain.beachTop && terrain.beachTop < 0
    && terrain.shelfKnee > 0 && terrain.shelfEnd > terrain.shelfKnee)) {
    throw new Error('water.sea.coast.terrain bands must be ordered inlandBlendStart < beachTop < 0 < shelfKnee < shelfEnd.');
  }
  if (!(sand.inlandStart < sand.inlandEnd && sand.inlandEnd < 0)) {
    throw new Error('water.sea.coast.sand.inlandStart/inlandEnd must be ordered below zero.');
  }
  if (!(vegetation.grassStart < vegetation.grassEnd
    && vegetation.groundcoverStart < vegetation.groundcoverEnd)) {
    throw new Error('water.sea.coast.vegetation bands must have increasing start/end values.');
  }
  if (!(scatter.inlandMin < scatter.inlandMax)) {
    throw new Error('water.sea.coast.scatter.inlandMax must exceed inlandMin.');
  }
  if (vegetation.minClumps > vegetation.maxClumps) {
    throw new Error('water.sea.coast.vegetation.maxClumps must be at least minClumps.');
  }
  assertPositive('water.sea.coast.wave.wavelength', wave.wavelength);
  assertPositive('water.sea.coast.swash.reach', swash.reach);
  assertPositive('water.sea.coast.swash.frontWidth', swash.frontWidth);
  assertPositive('water.sea.coast.swash.foamWidth', swash.foamWidth);
  assertPositive('water.sea.coast.moisture.wettingSeconds', moisture.wettingSeconds);
  assertPositive('water.sea.coast.moisture.dryingSeconds', moisture.dryingSeconds);
  assertPositive('water.sea.coast.vegetation.maxPatches', vegetation.maxPatches, true);

  const level = sea.level ?? -24;
  const shoreX = sea.shoreX ?? 1000;
  const depth = sea.depth ?? 95;
  for (const [name, value] of Object.entries({ level, shoreX, depth })) {
    if (!Number.isFinite(value)) throw new Error(`water.sea.${name} must be a finite number.`);
  }
  assertPositive('water.sea.depth', depth);
  if (depth <= terrain.shelfKneeDepth) {
    throw new Error('water.sea.depth must exceed water.sea.coast.terrain.shelfKneeDepth.');
  }

  const resolved = { ...sea, level, shoreX, depth, coast };
  Object.defineProperty(resolved, RESOLVED, { value: true });
  if (sea && typeof sea === 'object') cache.set(sea, resolved);
  return resolved;
}

function coastSource(shoreOrSea) {
  return typeof shoreOrSea === 'number' ? { shoreX: shoreOrSea } : (shoreOrSea ?? {});
}

export function coastX(z, shoreOrSea = 1000) {
  const sea = resolveCoastConfig(coastSource(shoreOrSea));
  const curve = sea.coast.curve;
  return sea.shoreX
    + Math.sin(z * curve.longFrequency) * curve.longAmplitude
    + Math.sin(z * curve.shortFrequency) * curve.shortAmplitude;
}

export function coastXNode(z, shoreOrSea = 1000) {
  const sea = resolveCoastConfig(coastSource(shoreOrSea));
  const curve = sea.coast.curve;
  return float(sea.shoreX)
    .add(sin(z.mul(curve.longFrequency)).mul(curve.longAmplitude))
    .add(sin(z.mul(curve.shortFrequency)).mul(curve.shortAmplitude));
}

export function coastDepth(distance, seaConfig = {}) {
  const sea = resolveCoastConfig(seaConfig);
  const terrain = sea.coast.terrain;
  return terrain.shelfKneeDepth * MathUtils.smoothstep(distance, 0, terrain.shelfKnee)
    + (sea.depth - terrain.shelfKneeDepth)
      * MathUtils.smoothstep(distance, terrain.shelfKnee, terrain.shelfEnd);
}

export function coastalHeight(x, z, land, seaConfig) {
  if (!seaConfig?.enabled) return land;
  const sea = resolveCoastConfig(seaConfig);
  const terrain = sea.coast.terrain;
  const d = x - coastX(z, sea);
  const { smoothstep, lerp } = MathUtils;
  if (d <= terrain.inlandBlendStart) return land;
  if (d < terrain.beachTop) {
    return lerp(land, sea.level + terrain.beachHeight,
      smoothstep(d, terrain.inlandBlendStart, terrain.beachTop));
  }
  if (d < 0) {
    return lerp(sea.level + terrain.beachHeight, sea.level,
      smoothstep(d, terrain.beachTop, 0));
  }
  return sea.level - coastDepth(d, sea);
}

function wrap01(value) {
  return value - Math.floor(value);
}

function beachPhase(distance, z, clock, sea) {
  const wave = sea.coast.wave;
  const frequency = TAU / wave.wavelength;
  return distance * frequency + clock * wave.speed
    + Math.sin(z * wave.bendFrequency) * wave.bend;
}

function swashState(distance, z, phase, sea, rain) {
  const { swash, moisture } = sea.coast;
  const age = wrap01((phase - Math.PI / 2) / TAU);
  const excursion = (1 - Math.cos(age * TAU)) * 0.5;
  const breakup = Math.sin(z * swash.breakupFrequency + phase * 0.17) * swash.breakupStrength;
  const front = swash.seawardStart
    - excursion * (swash.reach + swash.seawardStart)
    + breakup * swash.frontWidth;
  const coverage = MathUtils.smoothstep(distance, front - swash.frontWidth, front + swash.frontWidth);
  const frontDistance = Math.abs(distance - front);
  const foam = (1 - MathUtils.smoothstep(frontDistance, swash.foamCore, swash.foamWidth))
    * MathUtils.lerp(1 - swash.breakupStrength, 1,
      MathUtils.smoothstep(Math.sin(z * swash.breakupFrequency * 2.1 + phase) * 0.5 + 0.5, 0.2, 0.8));
  const sinceMaxRunup = wrap01(age - 0.5);
  const decay = MathUtils.lerp(moisture.washDecay, moisture.rainWashDecay, MathUtils.clamp(rain, 0, 1));
  const reachMask = 1 - MathUtils.smoothstep(-distance, swash.reach - swash.frontWidth, swash.reach + swash.frontWidth);
  const memory = reachMask * Math.exp(-sinceMaxRunup * decay);
  return { front, coverage, foam, memory };
}

export function sampleCoastField(x, z, clock, seaConfig, rain = 0) {
  const sea = resolveCoastConfig(seaConfig);
  const distance = x - coastX(z, sea);
  const phase = beachPhase(distance, z, clock, sea);
  const swash = swashState(distance, z, phase, sea, rain);
  const { moisture, vegetation, scatter } = sea.coast;
  const inland = -distance;
  const baseMoisture = MathUtils.smoothstep(distance, -moisture.baseReach, 0) * moisture.baseStrength;
  const vegetationSuitability = MathUtils.smoothstep(inland, vegetation.grassStart, vegetation.grassEnd) ** 3;
  const groundcoverSuitability = MathUtils.smoothstep(
    inland,
    vegetation.groundcoverStart,
    vegetation.groundcoverStart + vegetation.groundcoverEdge,
  ) * (1 - MathUtils.smoothstep(
    inland,
    vegetation.groundcoverEnd - vegetation.groundcoverEdge,
    vegetation.groundcoverEnd,
  ));
  const scatterSuitability = MathUtils.smoothstep(
    inland,
    scatter.inlandMin,
    scatter.inlandMin + scatter.edge,
  ) * (1 - MathUtils.smoothstep(
    inland,
    scatter.inlandMax - scatter.edge,
    scatter.inlandMax,
  ));

  return {
    signedCoastDistance: distance,
    oceanDepth: coastDepth(distance, sea),
    beachPhase: phase,
    shoreRunup: swash.front,
    waterCoverage: MathUtils.clamp(swash.coverage, 0, 1),
    foamFront: MathUtils.clamp(swash.foam, 0, 1),
    washMemory: MathUtils.clamp(swash.memory, 0, 1),
    waveWash: MathUtils.clamp(Math.max(swash.coverage, swash.memory), 0, 1),
    baseMoisture: MathUtils.clamp(baseMoisture, 0, 1),
    vegetationSuitability: MathUtils.clamp(vegetationSuitability, 0, 1),
    groundcoverSuitability: MathUtils.clamp(groundcoverSuitability, 0, 1),
    scatterSuitability: MathUtils.clamp(scatterSuitability, 0, 1),
  };
}

export function createCoastNodes(seaConfig, clock, rain) {
  const sea = resolveCoastConfig(seaConfig);
  const { terrain, wave, swash, moisture, vegetation, scatter } = sea.coast;
  const frequency = TAU / wave.wavelength;
  const distance = Fn(([p]) => p.x.sub(coastXNode(p.y, sea)));
  const depth = Fn(([p]) => distance(p).smoothstep(0, terrain.shelfKnee).mul(terrain.shelfKneeDepth)
    .add(distance(p).smoothstep(terrain.shelfKnee, terrain.shelfEnd).mul(sea.depth - terrain.shelfKneeDepth)));
  const beachPhaseNode = Fn(([p]) => distance(p).mul(frequency).add(clock.mul(wave.speed))
    .add(sin(p.y.mul(wave.bendFrequency)).mul(wave.bend)));
  const phaseAge = Fn(([p]) => beachPhaseNode(p).sub(Math.PI / 2).div(TAU).fract());
  const shoreRunup = Fn(([p]) => {
    const phase = beachPhaseNode(p);
    const age = phaseAge(p);
    const excursion = float(1).sub(cos(age.mul(TAU))).mul(0.5);
    const breakup = sin(p.y.mul(swash.breakupFrequency).add(phase.mul(0.17)))
      .mul(swash.breakupStrength * swash.frontWidth);
    return float(swash.seawardStart)
      .sub(excursion.mul(swash.reach + swash.seawardStart))
      .add(breakup);
  });
  const waterCoverage = Fn(([p]) => {
    const front = shoreRunup(p);
    return distance(p).smoothstep(front.sub(swash.frontWidth), front.add(swash.frontWidth));
  });
  const foamFront = Fn(([p]) => {
    const front = shoreRunup(p);
    const phase = beachPhaseNode(p);
    const ring = float(1).sub(distance(p).sub(front).abs().smoothstep(swash.foamCore, swash.foamWidth));
    const breakup = sin(p.y.mul(swash.breakupFrequency * 2.1).add(phase)).mul(0.5).add(0.5)
      .smoothstep(0.2, 0.8);
    return ring.mul(float(1 - swash.breakupStrength).add(breakup.mul(swash.breakupStrength)));
  });
  const washMemory = Fn(([p]) => {
    const sinceMaxRunup = phaseAge(p).sub(0.5).fract();
    const decay = float(moisture.washDecay).add(
      rain.mul(moisture.rainWashDecay - moisture.washDecay),
    );
    const reachMask = float(1).sub(distance(p).negate()
      .smoothstep(swash.reach - swash.frontWidth, swash.reach + swash.frontWidth));
    return reachMask.mul(sinceMaxRunup.mul(decay).negate().exp());
  });
  const waveWash = Fn(([p]) => waterCoverage(p).max(washMemory(p)));
  const baseMoisture = Fn(([p]) => distance(p).smoothstep(-moisture.baseReach, 0).mul(moisture.baseStrength));
  const vegetationSuitability = Fn(([p]) => distance(p).negate()
    .smoothstep(vegetation.grassStart, vegetation.grassEnd).pow(3));
  const groundcoverSuitability = Fn(([p]) => {
    const inland = distance(p).negate();
    return inland.smoothstep(vegetation.groundcoverStart, vegetation.groundcoverStart + vegetation.groundcoverEdge)
      .mul(float(1).sub(inland.smoothstep(
        vegetation.groundcoverEnd - vegetation.groundcoverEdge,
        vegetation.groundcoverEnd,
      )));
  });
  const scatterSuitability = Fn(([p]) => {
    const inland = distance(p).negate();
    return inland.smoothstep(scatter.inlandMin, scatter.inlandMin + scatter.edge)
      .mul(float(1).sub(inland.smoothstep(scatter.inlandMax - scatter.edge, scatter.inlandMax)));
  });
  return {
    distance,
    depth,
    beachPhase: beachPhaseNode,
    shoreRunup,
    waterCoverage,
    foamFront,
    washMemory,
    waveWash,
    baseMoisture,
    vegetationSuitability,
    groundcoverSuitability,
    scatterSuitability,
  };
}

export function seedBeachMoisture(rain) {
  return MathUtils.clamp(Number(rain) || 0, 0, 1);
}

export function advanceBeachMoisture(moisture, rain, delta, seaConfig = {}) {
  if (!Number.isFinite(delta) || delta <= 0) return moisture;
  const target = MathUtils.clamp(Number(rain) || 0, 0, 1);
  const current = MathUtils.clamp(Number(moisture) || 0, 0, 1);
  const params = resolveCoastConfig(seaConfig).coast.moisture;
  const seconds = target > current ? params.wettingSeconds : params.dryingSeconds;
  return MathUtils.lerp(current, target, -Math.expm1(-delta / seconds));
}
