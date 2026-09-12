import { MathUtils, Vector3 } from 'three';
import { coastDepth, resolveCoastConfig, sampleCoastField } from '../world/CoastField.js';

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
  mediumStrength: 0.8,
  fineStrength: 0.15,
  primaryWeight: 0.65,
  secondaryWeight: 0.35,
  primaryScrollX: 0.008,
  primaryScrollZ: 0.003,
  secondaryScrollX: -0.006,
  secondaryScrollZ: 0.005,
  fineScrollX: 0.005,
  fineScrollZ: -0.004,
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
  foamPersistence: 0.32,
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
});

export const SEA_STORM_SCALE = 1.65;
export const SEA_COMPONENTS = Object.freeze([
  [56, 0.48, 1, 0.28, 0],
  [38, 0.25, 0.83, -0.55, 1.3],
  [28, 0.14, 0.68, 0.74, 3.1],
  [20, 0.08, 0.96, -0.25, 0.8],
  [16, 0.05, 0.3, 0.95, 4.6],
].map(([wavelength, weight, x, z, phase]) => Object.freeze({
  wavelength,
  weight,
  x: x / Math.hypot(x, z),
  z: z / Math.hypot(x, z),
  phase,
  frequency: Math.PI * 2 / wavelength,
  speed: Math.sqrt(9.81 * Math.PI * 2 / wavelength) * 0.55,
})));

const SIGNED_DETAIL_KEYS = new Set([
  'primaryScrollX',
  'primaryScrollZ',
  'secondaryScrollX',
  'secondaryScrollZ',
  'fineScrollX',
  'fineScrollZ',
]);

function validateFiniteNonNegative(path, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite non-negative number.`);
  }
}

function validateFinite(path, value) {
  if (!Number.isFinite(value)) throw new Error(`${path} must be a finite number.`);
}

export function resolveSeaWaves(sea = {}) {
  const coast = resolveCoastConfig(sea);
  const params = { ...coast, ...SEA_WAVE_DEFAULTS, ...sea, coast: coast.coast };
  params.coast = coast.coast;
  params.detail = { ...SEA_DETAIL_DEFAULTS, ...(sea.detail ?? {}) };
  for (const key of Object.keys(SEA_WAVE_DEFAULTS)) {
    validateFiniteNonNegative(`water.sea.${key}`, params[key]);
  }
  for (const [key, value] of Object.entries(params.detail)) {
    const path = `water.sea.detail.${key}`;
    if (SIGNED_DETAIL_KEYS.has(key)) validateFinite(path, value);
    else validateFiniteNonNegative(path, value);
  }
  if (params.choppiness > 6) throw new Error('water.sea.choppiness must be between 0 and 6.');
  if (params.transitionEnd <= params.transitionStart) {
    throw new Error('water.sea.transitionEnd must exceed transitionStart.');
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
  for (const [start, end] of [
    ['roughnessMin', 'roughnessMax'],
    ['surfDepthStart', 'surfDepthEnd'],
    ['surfFadeStart', 'surfFadeEnd'],
    ['crestStart', 'crestEnd'],
  ]) {
    if (params.detail[end] <= params.detail[start]) {
      throw new Error(`water.sea.detail.${end} must exceed ${start}.`);
    }
  }
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
  const params = sea.detail ? sea : resolveSeaWaves(sea);
  const detail = params.detail;
  const spacing = Math.sin(z * detail.nearshoreSpacingFrequency)
    * detail.nearshoreSpacingVariation;
  const spatialFrequency = Math.PI * 2 / params.coast.wave.wavelength;
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

export function sampleSeaSurface(x, z, time, sea, rain = 0) {
  const p = resolveSeaWaves(sea);
  const { signedCoastDistance: distance, beachPhase } = sampleCoastField(x, z, time, p, rain);
  const storm = MathUtils.clamp(rain, 0, 1);
  const envelope = seaEnvelope(distance, p, storm);
  const sharpness = p.choppiness * 0.075 * (1 + storm * 0.5);
  const swell = SEA_COMPONENTS.reduce((height, wave) => height + wave.weight * seaWaveShape(
    (x * wave.x + z * wave.z) * wave.frequency + time * wave.speed + wave.phase,
    sharpness,
  ), 0);
  const beach = seaWaveShape(nearshoreWavePhase(beachPhase, distance, z, p), 0.45 + storm * 0.2);
  return MathUtils.lerp(beach, swell, envelope.offshore) * envelope.amplitude;
}

export function sampleSeaNormal(x, z, time, sea, rain = 0, step = 0.25) {
  const height = sampleSeaSurface(x, z, time, sea, rain);
  const dx = (sampleSeaSurface(x + step, z, time, sea, rain) - height) / step;
  const dz = (sampleSeaSurface(x, z + step, time, sea, rain) - height) / step;
  return new Vector3(-dx, 1, -dz).normalize();
}
