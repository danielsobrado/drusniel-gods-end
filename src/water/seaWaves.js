import { MathUtils, Vector3 } from 'three';
import { coastDepth, resolveCoastConfig, sampleCoastField } from '../world/CoastField.js';

const TAU = Math.PI * 2;
const GRAVITY = 9.81;
const SEA_PHASE_SPEED_SCALE = 0.55;

export const SEA_WAVE_DEFAULTS = Object.freeze({
  offshoreAmplitude: 1.6,
  beachAmplitude: 0.25,
  choppiness: 4,
  transitionStart: 30,
  transitionEnd: 180,
  detailStrength: 1,
  whitecapStrength: 1,
  crestTranslucency: 1,
});

export const SEA_DETAIL_DEFAULTS = Object.freeze({
  textureWorldScale: 32,
  mediumDistance: 780,
  fineDistance: 260,
  mediumScale: 1.73,
  fineScale: 5.7,
  mediumStrength: 0.42,
  fineStrength: 0.055,
  primaryWeight: 0.78,
  secondaryWeight: 0.22,
  // Short waves travel at their own deep-water speed (sqrt of wavelength),
  // several times slower than the swell; advectionRatio scales it. Riding
  // the swell comes from its orbital motion (WaterMaterial), not from
  // scrolling the ripples at swell speed, which read as a sliding texture.
  advectionRatio: 0.9,
  // Ripple crests across one detail tile: sets each layer's wavelength.
  rippleCrestsPerTile: 4,
  // Fraction of the swell's height its orbital motion carries ripples.
  orbitalAdvection: 0.8,
  carrierSlopeFadeStart: 0.93,
  carrierSlopeFadeEnd: 0.985,
  stormNormalBoost: 0.35,
  whitecapThreshold: 0.58,
  stormWhitecapThreshold: 0.38,
  whitecapSteepness: 0.16,
  whitecapCrestWeight: 0.82,
  whitecapSteepnessWeight: 0.18,
  whitecapRainBase: 0.55,
  whitecapRainBoost: 0.65,
  foamBreakupLow: 0.34,
  foamBreakupHigh: 0.7,
  surfDepthStart: 0.01,
  surfDepthEnd: 0.35,
  surfFadeStart: 2.5,
  surfFadeEnd: 7,
  roughnessVarianceScale: 0.16,
  roughnessBase: 0.055,
  roughnessStorm: 0.09,
  roughnessMin: 0.05,
  roughnessMax: 0.48,
  specularMinExponent: 18,
  specularMaxExponent: 190,
  specularSharpStrength: 1.55,
  specularBroadStrength: 0.12,
  crestStart: 0.28,
  crestEnd: 0.88,
  crestTransmissionStrength: 0.22,
  nearshoreLongFrequency: 0.021,
  nearshoreCrossFrequency: 0.047,
  nearshoreWarp: 0.32,
  nearshoreSpacingFrequency: 0.009,
  nearshoreSpacingVariation: 0.12,
  // Wave sets: each nearshore crest's height varies along its length and
  // from one wave to the next, so the crests are segments of stronger and
  // weaker swell rather than one unbroken comb of lines. setDepth is how far
  // the weakest stretch drops below full height.
  setDepth: 0.5,
  setGroup: 0.29,
  setAlongFrequency: 0.031,
  // Breaking surf: where a set wave runs into water about its own height
  // deep it spills, a white roll on its face and foam trailing behind it.
  // Depths (metres of water) where breaking starts, is full, fades and ends.
  breakDepthStart: 0.25,
  breakDepthFull: 0.7,
  breakDepthFade: 2.4,
  breakDepthEnd: 4.5,
  breakStrength: 1,
  breakTrail: 4.5,
  breakLaceScale: 0.19,
});

const RESOLVED_SEA_WAVES = Symbol('resolvedSeaWaves');
const resolvedSeaWaves = new WeakMap();

export const SEA_STORM_SCALE = 1.65;
export const SEA_COMPONENTS = Object.freeze([
  // Geometry carries broad swell only. Shorter structure belongs in the
  // filtered normal-detail path so it cannot visibly crawl over large waves.
  // Long, unequal wavelengths spread over ~70 degrees: 56 and 38 unit swells
  // (20 and 14 m) in near-parallel directions read as regular rows, a lake
  // with a pattern, rather than open ocean.
  [118, 0.53, 1, 0.22, 0],
  [74, 0.29, 0.72, -0.69, 1.3],
  [47, 0.1, 0.58, 0.81, 3.1],
  [31, 0.05, 0.97, -0.24, 0.8],
  [21, 0.03, 0.26, 0.97, 4.6],
].map(([wavelength, weight, x, z, phase]) => Object.freeze({
  wavelength,
  weight,
  x: x / Math.hypot(x, z),
  z: z / Math.hypot(x, z),
  phase,
  waveNumber: TAU / wavelength,
  angularSpeed: Math.sqrt(GRAVITY * TAU / wavelength) * SEA_PHASE_SPEED_SCALE,
})));

function validateFiniteNonNegative(path, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite non-negative number.`);
  }
}

export function resolveSeaWaves(sea = {}) {
  if (sea?.[RESOLVED_SEA_WAVES]) return sea;
  if (sea && typeof sea === 'object' && resolvedSeaWaves.has(sea)) return resolvedSeaWaves.get(sea);

  const coast = resolveCoastConfig(sea);
  const params = { ...coast, ...SEA_WAVE_DEFAULTS, ...sea, coast: coast.coast };
  params.coast = coast.coast;
  params.detail = { ...SEA_DETAIL_DEFAULTS, ...(sea.detail ?? {}) };
  for (const key of Object.keys(SEA_WAVE_DEFAULTS)) {
    validateFiniteNonNegative(`water.sea.${key}`, params[key]);
  }
  for (const [key, value] of Object.entries(params.detail)) {
    validateFiniteNonNegative(`water.sea.detail.${key}`, value);
  }
  if (params.choppiness > 6) throw new Error('water.sea.choppiness must be between 0 and 6.');
  if (params.transitionEnd <= params.transitionStart) {
    throw new Error('water.sea.transitionEnd must exceed transitionStart.');
  }
  for (const key of ['textureWorldScale', 'mediumDistance', 'fineDistance', 'mediumScale', 'fineScale']) {
    if (!(params.detail[key] > 0)) {
      throw new Error(`water.sea.detail.${key} must be greater than zero.`);
    }
  }
  if (params.detail.advectionRatio <= 0 || params.detail.advectionRatio > 1) {
    throw new Error('water.sea.detail.advectionRatio must be in (0, 1].');
  }
  if (params.detail.fineDistance > params.detail.mediumDistance) {
    throw new Error('water.sea.detail.mediumDistance must be at least fineDistance.');
  }
  if (params.detail.foamBreakupHigh <= params.detail.foamBreakupLow) {
    throw new Error('water.sea.detail.foamBreakupHigh must exceed foamBreakupLow.');
  }
  if (params.detail.nearshoreSpacingVariation > 0.45) {
    throw new Error('water.sea.detail.nearshoreSpacingVariation must not exceed 0.45.');
  }
  if (params.detail.setDepth > 1) {
    throw new Error('water.sea.detail.setDepth must not exceed 1.');
  }
  if (params.detail.carrierSlopeFadeEnd > 1) {
    throw new Error('water.sea.detail.carrierSlopeFadeEnd must not exceed 1.');
  }
  for (const [start, end] of [
    ['roughnessMin', 'roughnessMax'],
    ['surfDepthStart', 'surfDepthEnd'],
    ['surfFadeStart', 'surfFadeEnd'],
    ['crestStart', 'crestEnd'],
    ['carrierSlopeFadeStart', 'carrierSlopeFadeEnd'],
    ['breakDepthStart', 'breakDepthFull'],
    ['breakDepthFull', 'breakDepthFade'],
    ['breakDepthFade', 'breakDepthEnd'],
  ]) {
    if (params.detail[end] <= params.detail[start]) {
      throw new Error(`water.sea.detail.${end} must exceed ${start}.`);
    }
  }

  const detailLayers = [
    ['primary', 1, SEA_COMPONENTS[0]],
    ['secondary', params.detail.mediumScale, SEA_COMPONENTS[1]],
    ['fine', params.detail.fineScale, SEA_COMPONENTS[2]],
  ];
  for (const [name, scale] of detailLayers) {
    const wave = SEA_COMPONENTS[detailLayers.findIndex(([layer]) => layer === name)];
    // Deep-water dispersion at the layer's own ripple wavelength.
    const rippleLength = params.detail.textureWorldScale / scale / params.detail.rippleCrestsPerTile;
    const phaseSpeed = Math.sqrt(GRAVITY * rippleLength / TAU) * SEA_PHASE_SPEED_SCALE;
    const uvSpeed = phaseSpeed * params.detail.advectionRatio * scale / params.detail.textureWorldScale;
    Object.defineProperties(params.detail, {
      [`${name}ScrollX`]: { value: wave.x * uvSpeed },
      [`${name}ScrollZ`]: { value: wave.z * uvSpeed },
    });
  }
  Object.defineProperty(params, RESOLVED_SEA_WAVES, { value: true });
  if (sea && typeof sea === 'object') resolvedSeaWaves.set(sea, params);
  return params;
}

export const seaDepth = coastDepth;

export function seaEnvelope(distance, sea, rain = 0) {
  const p = resolveSeaWaves(sea);
  const depth = seaDepth(distance, p);
  const offshore = MathUtils.smoothstep(distance, p.transitionStart, p.transitionEnd);
  const height = MathUtils.lerp(p.beachAmplitude, p.offshoreAmplitude, offshore)
    * (1 + MathUtils.clamp(rain, 0, 1) * (SEA_STORM_SCALE - 1));
  return {
    depth,
    offshore,
    amplitude: Math.min(height, depth * 0.42) * MathUtils.smoothstep(depth, 0, 0.15),
  };
}

export function seaDisplacementBound(sea) {
  const p = resolveSeaWaves(sea);
  return Math.max(p.offshoreAmplitude, p.beachAmplitude) * SEA_STORM_SCALE;
}

export function seaWaveShape(phase, sharpness) {
  const s = Math.sin(phase);
  return (s + sharpness * (s * s - 0.5)) / (1 + sharpness * 0.5);
}

export function nearshoreWavePhase(basePhase, distance, z, sea) {
  const params = resolveSeaWaves(sea);
  const detail = params.detail;
  const spacing = Math.sin(z * detail.nearshoreSpacingFrequency)
    * detail.nearshoreSpacingVariation;
  const spatialFrequency = TAU / params.coast.wave.wavelength;
  const spacingOffset = distance * spatialFrequency * spacing;
  const cross = Math.sin(
    z * detail.nearshoreLongFrequency
      + Math.sin(z * detail.nearshoreCrossFrequency) * 1.7,
  ) * detail.nearshoreWarp;
  const counter = Math.sin(
    z * detail.nearshoreCrossFrequency * 0.73
      + Math.sin(z * detail.nearshoreLongFrequency * 1.37),
  ) * detail.nearshoreWarp * 0.45;
  return basePhase + spacingOffset + cross + counter;
}

// Share of full height a nearshore crest carries here (see setDepth); the
// same expression as seaNodes' setEnvelope.
export function nearshoreSetEnvelope(basePhase, z, sea) {
  const detail = resolveSeaWaves(sea).detail;
  const set = Math.sin(basePhase * detail.setGroup + z * detail.setAlongFrequency
    + Math.sin(z * detail.setAlongFrequency * 0.41 + 1.3) * 1.6) * 0.5 + 0.5;
  return 1 - detail.setDepth * set;
}

export function sampleSeaSurface(x, z, time, sea, rain = 0) {
  const p = resolveSeaWaves(sea);
  const { signedCoastDistance: distance, beachPhase } = sampleCoastField(x, z, time, p, rain);
  const storm = MathUtils.clamp(rain, 0, 1);
  const envelope = seaEnvelope(distance, p, storm);
  const sharpness = p.choppiness * 0.075 * (1 + storm * 0.5);
  const swell = SEA_COMPONENTS.reduce((height, wave) => height + wave.weight * seaWaveShape(
    (x * wave.x + z * wave.z) * wave.waveNumber + time * wave.angularSpeed + wave.phase,
    sharpness,
  ), 0);
  const beach = seaWaveShape(nearshoreWavePhase(beachPhase, distance, z, p), 0.45 + storm * 0.2)
    * nearshoreSetEnvelope(beachPhase, z, p);
  return MathUtils.lerp(beach, swell, envelope.offshore) * envelope.amplitude;
}

export function sampleSeaNormal(x, z, time, sea, rain = 0, step = 0.25) {
  const height = sampleSeaSurface(x, z, time, sea, rain);
  const dx = (sampleSeaSurface(x + step, z, time, sea, rain) - height) / step;
  const dz = (sampleSeaSurface(x, z + step, time, sea, rain) - height) / step;
  return new Vector3(-dx, 1, -dz).normalize();
}
