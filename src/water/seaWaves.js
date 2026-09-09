import { MathUtils } from 'three';
import { coastX } from '../world/coast.js';

export const SEA_WAVE_DEFAULTS = Object.freeze({ offshoreAmplitude: 1.2, beachAmplitude: 0.25,
  choppiness: 4, transitionStart: 30, transitionEnd: 180 });
export const SEA_STORM_SCALE = 1.65;
export const SEA_COMPONENTS = Object.freeze([
  [38, 0.48, 1, 0.28, 0], [24, 0.25, 0.83, -0.55, 1.3],
  [15, 0.14, 0.68, 0.74, 3.1], [9.5, 0.08, 0.96, -0.25, 0.8],
  [6.2, 0.05, 0.3, 0.95, 4.6],
].map(([wavelength, weight, x, z, phase]) => Object.freeze({ wavelength, weight,
  x: x / Math.hypot(x, z), z: z / Math.hypot(x, z), phase,
  frequency: Math.PI * 2 / wavelength, speed: Math.sqrt(9.81 * Math.PI * 2 / wavelength) * 0.55 })));

export function resolveSeaWaves(sea = {}) {
  const params = { ...SEA_WAVE_DEFAULTS, ...sea };
  for (const key of Object.keys(SEA_WAVE_DEFAULTS)) {
    if (!Number.isFinite(params[key]) || params[key] < 0) throw new Error(`water.sea.${key} must be a finite non-negative number.`);
  }
  if (params.choppiness > 6) throw new Error('water.sea.choppiness must be between 0 and 6.');
  if (params.transitionEnd <= params.transitionStart) throw new Error('water.sea.transitionEnd must exceed transitionStart.');
  return params;
}

// Same analytic shelf as coastalHeight, including beyond the finite terrain map.
export function seaDepth(distance, sea) {
  return 9 * MathUtils.smoothstep(distance, 0, 80)
    + ((sea.depth ?? 95) - 9) * MathUtils.smoothstep(distance, 80, 500);
}

export function seaEnvelope(distance, sea, rain = 0) {
  const p = resolveSeaWaves(sea), depth = seaDepth(distance, p);
  const offshore = MathUtils.smoothstep(distance, p.transitionStart, p.transitionEnd);
  const height = MathUtils.lerp(p.beachAmplitude, p.offshoreAmplitude, offshore)
    * (1 + MathUtils.clamp(rain, 0, 1) * (SEA_STORM_SCALE - 1));
  return { depth, offshore, amplitude: Math.min(height, depth * 0.42) * MathUtils.smoothstep(depth, 0, 0.15) };
}

export function seaDisplacementBound(sea) {
  const p = resolveSeaWaves(sea);
  return Math.max(p.offshoreAmplitude, p.beachAmplitude) * SEA_STORM_SCALE;
}

// A zero-mean second harmonic sharpens crests without lifting the mean sea level.
export function seaWaveShape(phase, sharpness) {
  const s = Math.sin(phase);
  return (s + sharpness * (s * s - 0.5)) / (1 + sharpness * 0.5);
}

// CPU reference used by coastal diagnostics and invariant tests. The shader uses
// these same coefficients and envelope; neither changes the player's water level.
export function sampleSeaSurface(x, z, time, sea, rain = 0) {
  const p = resolveSeaWaves(sea), distance = x - coastX(z, p.shoreX);
  const envelope = seaEnvelope(distance, p, rain);
  const sharpness = p.choppiness * 0.075;
  const swell = SEA_COMPONENTS.reduce((height, wave) => height + wave.weight * seaWaveShape(
    (x * wave.x + z * wave.z) * wave.frequency + time * wave.speed + wave.phase, sharpness), 0);
  const beach = seaWaveShape(distance * (Math.PI * 2 / 13) + time * 1.35 + Math.sin(z * 0.085) * 0.32, 0.45);
  return MathUtils.lerp(beach, swell, envelope.offshore) * envelope.amplitude;
}
