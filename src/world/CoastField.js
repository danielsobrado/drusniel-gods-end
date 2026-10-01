import { MathUtils } from 'three';
import { Fn, cos, float, sin } from 'three/tsl';
import { gradientNoise } from './MountainNoise.js';

const TAU = Math.PI * 2;
// Mean analytical depth, shared by ground and sea so their shallow optical
// coverage crosses over smoothly without depending on displaced fragments.
const SEA_COVERAGE_DEPTH_START = 0.015;
const SEA_COVERAGE_DEPTH_END = 0.15;
// Real depth of ground below still water over which the sea surface fades in
// and the ground's swash film fades out (complementary in both shaders). The
// sea reads ground height from the terrain height texture, so the band is a
// little wider than the analytic one to hide texel-scale mismatch.
export const SEA_SHORE_OPACITY_START = 0.015;
export const SEA_SHORE_OPACITY_END = 0.35;

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
    erosionSeed: 58181,
    erosionFrequency: 0.018,
    erosionSecondaryFrequency: 0.055,
    erosionAmplitude: 4.5,
    erosionDetailWeight: 0.38,
    erosionFootWarp: 8,
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
    // Water depth at which an incoming wave's foam line forms. The front then
    // rises through the shallows, crosses the waterline and runs up the sand.
    breakDepth: 0.6,
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
    slopeStart: 0.45,
    slopeEnd: 0.82,
    cliffRockTint: '#aa9879',
    cliffRockTintStrength: 0.28,
    baseMoistureStrength: 1,
    washMemoryStrength: 0.55,
    rainMoistureStrength: 0.8,
    coverageWetness: 0.85,
    // The swash sheet: how much of the bed's clear-water look shows through
    // it, and the aqua it multiplies the sand by.
    filmClarity: 0.75,
    filmTint: '#9fe3ea',
    filmTintStrength: 0.6,
    filmRoughness: 0.08,
    foamColor: '#edf8fb',
    foamStrength: 0.92,
    foamRoughness: 0.72,
    normalFrequencyX: 18.7,
    normalFrequencyZ: 21.3,
    normalStrength: 0.025,
    wetNormalFlattening: 0.7,
    filmNormalFlattening: 0.9,
    // Interaction shared with the alpine snow: footprints from the snow
    // deformation field, quartz glints from snowGlints and kicked sand from the
    // powder pool.
    footprintDarkening: 0.32,
    footprintBermLighten: 0.06,
    footprintNormalStrength: 1,
    glintStrength: 0.35,
    glintGrazing: 0.7,
    glintWorldScale: 2.78,
    kickColor: '#d9c49e',
    kickMultiplier: 0.6,
    kickLift: 0.55,
    kickLifetime: 0.65,
  }),
  // The sea floor past the swash: sand seen through clear water, reef patches
  // of weed-grown rock across the shelf, and sunlit caustics. Depths are
  // metres below still water.
  seabed: Object.freeze({
    start: 0.08,
    full: 0.75,
    color: '#efe6cf',
    colorWeight: 0.55,
    darkening: 0.14,
    reefShallow: 1.6,
    reefFull: 3.5,
    reefFadeStart: 11,
    reefFadeEnd: 18,
    reefFrequency: 0.03,
    reefWarp: 0.9,
    reefThreshold: 0.16,
    reefEdge: 0.07,
    reefColor: '#27361f',
    reefRockColor: '#4d4436',
    causticStrength: 0.9,
    causticScale: 0.62,
    causticShallow: 0.08,
    causticDepth: 16,
    causticDistance: 150,
  }),
  // Coconut palms along the top of the beach (BeachPalms): in groves along
  // the shore, thickest at the vegetation line and thinning toward the sea,
  // most of them leaning seaward. Distances are metres inland of the analytic
  // coast curve.
  palms: Object.freeze({
    seed: 40417,
    count: 800,
    attempts: 26000,
    inlandMin: 26,
    inlandMax: 135,
    inlandBias: 1.7,
    groveFrequency: 0.021,
    groveThreshold: 0.2,
    minSpacing: 4.2,
    minHeightAboveSea: 1.4,
    minNormalY: 0.84,
    pathClearance: 0.02,
    riverClearance: 9,
    scaleMin: 1,
    scaleMax: 1.65,
    leanMin: 0.04,
    leanMax: 0.36,
    seawardLean: 0.8,
    sway: 0.28,
    flutter: 0.07,
    // Sunlit coconut fronds are a yellower, lighter green than the jungle's.
    frondTint: '#f0f7b4',
    frondBrightness: 1.3,
    distance: 1200,
    // Shore length (metres) per instanced set, so stretches out of view cull.
    chunkSize: 180,
    colliderWidth: 0.6,
    colliderHeight: 3,
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
    clusterRadius: 0.42,
    groundOffset: 0.025,
    roughness: 0.9,
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
    patchFrequencyX: 0.17,
    patchFrequencyZ: 0.23,
    patchWarpFrequency: 0.12,
    clusterPower: 1.45,
    minNormalY: 0.9,
    sizeMin: 0.06,
    sizeMax: 0.19,
    twigLength: 2.4,
    twigRadius: 0.055,
    twigBend: 0.18,
    cliffRockAttempts: 700,
    cliffRockDensity: 0.14,
    cliffRockBand: 18,
    cliffRockMinNormalY: 0.72,
    cliffRockSizeMin: 0.28,
    cliffRockSizeMax: 0.85,
    pebbleColor: '#625c4e',
    shellColor: '#c9bea2',
    twigColor: '#7b674d',
    cliffRockColor: '#827765',
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

  const { terrain, wave, swash, moisture, sand, seabed, palms, vegetation, scatter } = coast;
  if (!(palms.inlandMin < palms.inlandMax && palms.scaleMin <= palms.scaleMax && palms.leanMin <= palms.leanMax)) {
    throw new Error('water.sea.coast.palms inland, scale and lean ranges must be ordered min < max.');
  }
  if (palms.seawardLean < 0 || palms.seawardLean > 1) {
    throw new Error('water.sea.coast.palms.seawardLean must be between zero and one.');
  }
  assertPositive('water.sea.coast.palms.count', palms.count, true);
  assertPositive('water.sea.coast.palms.minSpacing', palms.minSpacing);
  assertPositive('water.sea.coast.palms.distance', palms.distance);
  assertPositive('water.sea.coast.palms.chunkSize', palms.chunkSize);
  if (!(seabed.start < seabed.full && seabed.reefShallow < seabed.reefFull
    && seabed.reefFadeStart < seabed.reefFadeEnd && seabed.causticShallow < seabed.causticDepth)) {
    throw new Error('water.sea.coast.seabed depth bands must have increasing start/end values.');
  }
  for (const key of ['colorWeight', 'darkening']) {
    if (seabed[key] < 0 || seabed[key] > 1) {
      throw new Error(`water.sea.coast.seabed.${key} must be between zero and one.`);
    }
  }
  assertPositive('water.sea.coast.seabed.reefFrequency', seabed.reefFrequency);
  assertPositive('water.sea.coast.seabed.reefEdge', seabed.reefEdge);
  assertPositive('water.sea.coast.seabed.causticScale', seabed.causticScale);
  assertPositive('water.sea.coast.seabed.causticDistance', seabed.causticDistance);
  if (!(terrain.inlandBlendStart < terrain.beachTop && terrain.beachTop < 0
    && terrain.shelfKnee > 0 && terrain.shelfEnd > terrain.shelfKnee)) {
    throw new Error('water.sea.coast.terrain bands must be ordered inlandBlendStart < beachTop < 0 < shelfKnee < shelfEnd.');
  }
  if (!(sand.inlandStart < sand.inlandEnd && sand.inlandEnd < 0)) {
    throw new Error('water.sea.coast.sand.inlandStart/inlandEnd must be ordered below zero.');
  }
  if (!(sand.grainFadeStart < sand.grainFadeEnd)) {
    throw new Error('water.sea.coast.sand.grainFadeStart must be less than grainFadeEnd.');
  }
  if (!(sand.slopeStart >= 0 && sand.slopeStart < sand.slopeEnd && sand.slopeEnd <= 1)) {
    throw new Error('water.sea.coast.sand.slopeStart/slopeEnd must satisfy 0 <= slopeStart < slopeEnd <= 1.');
  }
  if (sand.cliffRockTintStrength < 0 || sand.cliffRockTintStrength > 1) {
    throw new Error('water.sea.coast.sand.cliffRockTintStrength must be between zero and one.');
  }
  if (!(vegetation.grassStart < vegetation.grassEnd
    && vegetation.groundcoverStart < vegetation.groundcoverEnd)) {
    throw new Error('water.sea.coast.vegetation bands must have increasing start/end values.');
  }
  if (!(scatter.inlandMin < scatter.inlandMax)) {
    throw new Error('water.sea.coast.scatter.inlandMax must exceed inlandMin.');
  }
  if (!(scatter.cliffRockSizeMin < scatter.cliffRockSizeMax)) {
    throw new Error('water.sea.coast.scatter.cliffRockSizeMax must exceed cliffRockSizeMin.');
  }
  if (scatter.cliffRockDensity < 0 || scatter.cliffRockDensity > 1) {
    throw new Error('water.sea.coast.scatter.cliffRockDensity must be between zero and one.');
  }
  if (scatter.cliffRockMinNormalY < 0 || scatter.cliffRockMinNormalY > 1) {
    throw new Error('water.sea.coast.scatter.cliffRockMinNormalY must be between zero and one.');
  }
  if (vegetation.minClumps > vegetation.maxClumps) {
    throw new Error('water.sea.coast.vegetation.maxClumps must be at least minClumps.');
  }
  assertPositive('water.sea.coast.wave.wavelength', wave.wavelength);
  assertPositive('water.sea.coast.terrain.shelfKneeDepth', terrain.shelfKneeDepth);
  assertPositive('water.sea.coast.terrain.erosionFrequency', terrain.erosionFrequency);
  assertPositive('water.sea.coast.terrain.erosionSecondaryFrequency', terrain.erosionSecondaryFrequency);
  assertPositive('water.sea.coast.terrain.erosionAmplitude', terrain.erosionAmplitude, true);
  assertPositive('water.sea.coast.terrain.erosionFootWarp', terrain.erosionFootWarp, true);
  if (terrain.erosionDetailWeight < 0 || terrain.erosionDetailWeight > 1) {
    throw new Error('water.sea.coast.terrain.erosionDetailWeight must be between zero and one.');
  }
  assertPositive('water.sea.coast.swash.reach', swash.reach);
  assertPositive('water.sea.coast.swash.frontWidth', swash.frontWidth);
  assertPositive('water.sea.coast.swash.foamWidth', swash.foamWidth);
  assertPositive('water.sea.coast.swash.foamCore', swash.foamCore, true);
  assertPositive('water.sea.coast.swash.breakDepth', swash.breakDepth, true);
  if (swash.foamCore >= swash.foamWidth) {
    throw new Error('water.sea.coast.swash.foamCore must be less than foamWidth.');
  }
  assertPositive('water.sea.coast.moisture.baseReach', moisture.baseReach);
  assertPositive('water.sea.coast.moisture.wettingSeconds', moisture.wettingSeconds);
  assertPositive('water.sea.coast.moisture.dryingSeconds', moisture.dryingSeconds);
  assertPositive('water.sea.coast.vegetation.maxPatches', vegetation.maxPatches, true);
  assertPositive('water.sea.coast.vegetation.groundcoverEdge', vegetation.groundcoverEdge);
  assertPositive('water.sea.coast.scatter.edge', scatter.edge);
  assertPositive('water.sea.coast.scatter.clusterPower', scatter.clusterPower);
  assertPositive('water.sea.coast.scatter.twigLength', scatter.twigLength);
  assertPositive('water.sea.coast.scatter.twigRadius', scatter.twigRadius);
  assertPositive('water.sea.coast.scatter.twigBend', scatter.twigBend, true);
  assertPositive('water.sea.coast.scatter.cliffRockAttempts', scatter.cliffRockAttempts, true);
  assertPositive('water.sea.coast.scatter.cliffRockBand', scatter.cliffRockBand);
  assertPositive('water.sea.coast.vegetation.clusterRadius', vegetation.clusterRadius, true);
  assertPositive('water.sea.coast.vegetation.groundOffset', vegetation.groundOffset, true);
  if (vegetation.roughness < 0 || vegetation.roughness > 1) {
    throw new Error('water.sea.coast.vegetation.roughness must be between zero and one.');
  }

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
  if (d >= 0) return sea.level - coastDepth(d, sea);

  const footNoise = gradientNoise(
    z * terrain.erosionFrequency,
    z * terrain.erosionFrequency * 0.37 + 11.3,
    terrain.erosionSeed + 317,
  )[0];
  const localBeachTop = terrain.beachTop + footNoise * terrain.erosionFootWarp;

  if (d < localBeachTop) {
    const t = smoothstep(d, terrain.inlandBlendStart, localBeachTop);
    const coarse = gradientNoise(
      d * terrain.erosionFrequency * 0.42,
      z * terrain.erosionFrequency,
      terrain.erosionSeed,
    )[0];
    const detail = gradientNoise(
      d * terrain.erosionSecondaryFrequency * 0.55 + 17.3,
      z * terrain.erosionSecondaryFrequency - 9.1,
      terrain.erosionSeed + 101,
    )[0];
    const relief = lerp(coarse, detail, terrain.erosionDetailWeight);
    const gully = Math.max(0, -relief);
    const erosion = (relief * 0.55 - gully * 0.45)
      * terrain.erosionAmplitude * Math.sin(Math.PI * t);
    return lerp(land, sea.level + terrain.beachHeight, t) + erosion;
  }
  return lerp(sea.level + terrain.beachHeight, sea.level,
    smoothstep(d, localBeachTop, 0));
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
  const coverageAt = (samplePhase) => {
    const age = wrap01((samplePhase - Math.PI / 2) / TAU);
    const excursion = (1 - Math.cos(age * TAU)) * 0.5;
    const breakup = Math.sin(z * swash.breakupFrequency + samplePhase * 0.17) * swash.breakupStrength;
    const front = Math.max(-swash.reach, swash.seawardStart
      - excursion * (swash.reach + swash.seawardStart)
      + breakup * swash.frontWidth);
    // The softened edge begins at the configured limit instead of leaking inland
    // by a front width when breakup places the front at maximum run-up.
    const coverage = MathUtils.smoothstep(
      distance,
      Math.max(-swash.reach, front - swash.frontWidth),
      front + swash.frontWidth,
    );
    return { front, coverage };
  };
  const { front, coverage } = coverageAt(phase);
  const frontDistance = Math.abs(distance - front);
  const foam = coverage * (1 - MathUtils.smoothstep(frontDistance, swash.foamCore, swash.foamWidth))
    * MathUtils.lerp(1 - swash.breakupStrength, 1,
      MathUtils.smoothstep(Math.sin(z * swash.breakupFrequency * 2.1 + phase) * 0.5 + 0.5, 0.2, 0.8));
  const decay = MathUtils.lerp(moisture.washDecay, moisture.rainWashDecay, MathUtils.clamp(rain, 0, 1));
  // A finite, exponentially weighted history of actual coverage avoids a
  // phase-reset seam and cannot wet locations that the front never reaches.
  let memory = coverage;
  for (const cyclesAgo of [0.15, 0.3, 0.45, 0.6]) {
    memory = Math.max(
      memory,
      coverageAt(phase - TAU * cyclesAgo).coverage * Math.exp(-cyclesAgo * decay),
    );
  }
  return { front, coverage, foam, memory };
}

// Same value as sampleCoastField().signedCoastDistance without evaluating the
// swash, moisture and suitability terms.
export function coastDistanceAt(x, z, seaConfig) {
  return x - coastX(z, resolveCoastConfig(seaConfig));
}

// CPU beach-sand mask for footprints and kicked sand. `coverage` matches the
// ground shader's coastal sand blend above the waterline; `dryness` is the
// inverse of the shoreline's base moisture, so only dry sand throws powder.
export function sampleSandCoverageCpu(x, y, z, config) {
  const seaConfig = config.water?.sea;
  if (!seaConfig?.enabled) return { coverage: 0, dryness: 0 };
  const sea = resolveCoastConfig(seaConfig);
  const distance = coastDistanceAt(x, z, sea);
  const { sand, moisture } = sea.coast;
  const band = MathUtils.smoothstep(distance, sand.inlandStart, sand.inlandEnd);
  const aboveWater = MathUtils.smoothstep(y, sea.level - 0.2, sea.level + 0.3);
  return {
    coverage: band * aboveWater,
    dryness: 1 - MathUtils.smoothstep(distance, -moisture.baseReach, 0),
  };
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

  const oceanDepth = coastDepth(distance, sea);
  return {
    signedCoastDistance: distance,
    oceanDepth,
    beachPhase: phase,
    shoreRunup: swash.front,
    waterCoverage: MathUtils.clamp(swash.coverage, 0, 1),
    seaCoverage: MathUtils.smoothstep(oceanDepth, SEA_COVERAGE_DEPTH_START, SEA_COVERAGE_DEPTH_END),
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
  const shoreRunupAtPhase = Fn(([p, phase]) => {
    const age = phase.sub(Math.PI / 2).div(TAU).fract();
    const excursion = float(1).sub(cos(age.mul(TAU))).mul(0.5);
    const breakup = sin(p.y.mul(swash.breakupFrequency).add(phase.mul(0.17)))
      .mul(swash.breakupStrength * swash.frontWidth);
    return float(swash.seawardStart)
      .sub(excursion.mul(swash.reach + swash.seawardStart))
      .add(breakup)
      .max(-swash.reach);
  });
  const waterCoverageAtPhase = Fn(([p, phase]) => {
    const front = shoreRunupAtPhase(p, phase);
    return distance(p).smoothstep(
      front.sub(swash.frontWidth).max(-swash.reach),
      front.add(swash.frontWidth),
    );
  });
  const shoreRunup = Fn(([p]) => shoreRunupAtPhase(p, beachPhaseNode(p)));
  const waterCoverage = Fn(([p]) => waterCoverageAtPhase(p, beachPhaseNode(p)));
  const seaCoverage = Fn(([p]) => depth(p)
    .smoothstep(SEA_COVERAGE_DEPTH_START, SEA_COVERAGE_DEPTH_END));
  const foamFront = Fn(([p]) => {
    const front = shoreRunup(p);
    const phase = beachPhaseNode(p);
    const ring = float(1).sub(distance(p).sub(front).abs().smoothstep(swash.foamCore, swash.foamWidth));
    const breakup = sin(p.y.mul(swash.breakupFrequency * 2.1).add(phase)).mul(0.5).add(0.5)
      .smoothstep(0.2, 0.8);
    return waterCoverage(p).mul(ring)
      .mul(float(1 - swash.breakupStrength).add(breakup.mul(swash.breakupStrength)));
  });
  const washMemory = Fn(([p]) => {
    const phase = beachPhaseNode(p);
    const decay = float(moisture.washDecay).add(
      rain.clamp(0, 1).mul(moisture.rainWashDecay - moisture.washDecay),
    );
    let memory = waterCoverageAtPhase(p, phase).toVar();
    for (const cyclesAgo of [0.15, 0.3, 0.45, 0.6]) {
      memory.assign(memory.max(waterCoverageAtPhase(p, phase.sub(TAU * cyclesAgo))
        .mul(float(-cyclesAgo).mul(decay).exp())));
    }
    return memory;
  });
  const waveWash = Fn(([p]) => waterCoverage(p).max(washMemory(p)));

  // The same swash cycle expressed as a height instead of a distance from the
  // analytic coast curve. Terrain erosion moves the real waterline metres off
  // that curve, so a distance-placed film floated above dry sand, detached from
  // the sea by a strip of beach and edged by two foam lines. Heights are
  // measured against still water, so these follow the actual sand: the front
  // forms `breakDepth` down in the shallows, crosses the waterline and runs up
  // the beach, reaching further on flat sand than on steep.
  const beachSlope = terrain.beachHeight / Math.abs(terrain.beachTop);
  const runupHeight = swash.reach * beachSlope;
  const frontHeightAtPhase = Fn(([p, phase]) => {
    const age = phase.sub(Math.PI / 2).div(TAU).fract();
    const excursion = float(1).sub(cos(age.mul(TAU))).mul(0.5);
    const breakup = sin(p.y.mul(swash.breakupFrequency).add(phase.mul(0.17)))
      .mul(swash.breakupStrength * swash.frontWidth * beachSlope);
    return excursion.mul(runupHeight + swash.breakDepth).sub(swash.breakDepth).add(breakup);
  });
  const frontBand = swash.frontWidth * beachSlope;
  // A beach has one run-up front per wave. Its timing is the incoming wave's
  // phase at the waterline (distance 0), so it varies along the shore but not
  // across it; the local phase repeats every wavelength and, on sand this
  // flat, put three fronts across one swash zone.
  const shorePhase = Fn(([p]) => clock.mul(wave.speed).add(sin(p.y.mul(wave.bendFrequency)).mul(wave.bend)));
  // `h` is the ground's height above still water (negative under the sea).
  const swashCoverageAt = Fn(([p, h, phase]) => {
    const front = frontHeightAtPhase(p, phase);
    return float(1).sub(h.smoothstep(front.sub(frontBand), front.add(frontBand)));
  });
  const swashCoverage = Fn(([p, h]) => swashCoverageAt(p, h, shorePhase(p)));
  const swashFoam = Fn(([p, h]) => {
    const phase = shorePhase(p);
    const ring = float(1).sub(h.sub(frontHeightAtPhase(p, phase)).abs()
      .smoothstep(swash.foamCore * beachSlope, swash.foamWidth * beachSlope));
    const breakup = sin(p.y.mul(swash.breakupFrequency * 2.1).add(phase)).mul(0.5).add(0.5)
      .smoothstep(0.2, 0.8);
    return ring.mul(float(1 - swash.breakupStrength).add(breakup.mul(swash.breakupStrength)));
  });
  const swashMemory = Fn(([p, h]) => {
    const phase = shorePhase(p);
    const decay = float(moisture.washDecay).add(
      rain.clamp(0, 1).mul(moisture.rainWashDecay - moisture.washDecay),
    );
    const memory = swashCoverageAt(p, h, phase).toVar();
    for (const cyclesAgo of [0.15, 0.3, 0.45, 0.6]) {
      memory.assign(memory.max(swashCoverageAt(p, h, phase.sub(TAU * cyclesAgo))
        .mul(float(-cyclesAgo).mul(decay).exp())));
    }
    return memory;
  });
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
    seaCoverage,
    foamFront,
    washMemory,
    waveWash,
    swashCoverage,
    swashFoam,
    swashMemory,
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
