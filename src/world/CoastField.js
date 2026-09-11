import { MathUtils } from 'three';
import { Fn, sin } from 'three/tsl';
import { coastX, coastXNode } from './coast.js';

export const BEACH_WAVE = Object.freeze({ frequency: Math.PI * 2 / 13, speed: 1.35, bendFrequency: 0.085, bend: 0.32 });

export function coastDepth(distance, sea) {
  return 9 * MathUtils.smoothstep(distance, 0, 80)
    + ((sea.depth ?? 95) - 9) * MathUtils.smoothstep(distance, 80, 500);
}

// Analytic recent-wash memory: the last crest leaves moisture which decays
// through the wave cycle. Rain raises the baseline separately, without shifting
// the coastline or creating a different biome.
export function sampleCoastField(x, z, clock, sea, rain = 0) {
  const d = x - coastX(z, sea.shoreX);
  const phase = d * BEACH_WAVE.frequency + clock * BEACH_WAVE.speed + Math.sin(z * BEACH_WAVE.bendFrequency) * BEACH_WAVE.bend;
  const age = ((phase - Math.PI / 2) / (Math.PI * 2) % 1 + 1) % 1;
  const reach = MathUtils.smoothstep(d, -12, -1);
  return {
    signedCoastDistance: d, oceanDepth: coastDepth(d, sea), beachPhase: phase,
    waveWash: reach * Math.max(Math.exp(-age * (4 - MathUtils.clamp(rain, 0, 1) * 2)), MathUtils.smoothstep(age, 0.88, 1)),
    baseMoisture: MathUtils.smoothstep(d, -32, 0) * 0.55,
    vegetationSuitability: MathUtils.smoothstep(-d, 45, 140) ** 3,
    scatterSuitability: MathUtils.smoothstep(-d, 20, 40) * (1 - MathUtils.smoothstep(-d, 95, 140)),
  };
}

export function createCoastNodes(sea, clock, rain) {
  const distance = Fn(([p]) => p.x.sub(coastXNode(p.y, sea.shoreX ?? 1000)));
  const depth = Fn(([p]) => distance(p).smoothstep(0, 80).mul(9)
    .add(distance(p).smoothstep(80, 500).mul((sea.depth ?? 95) - 9)));
  const beachPhase = Fn(([p]) => distance(p).mul(BEACH_WAVE.frequency).add(clock.mul(BEACH_WAVE.speed))
    .add(sin(p.y.mul(BEACH_WAVE.bendFrequency)).mul(BEACH_WAVE.bend)));
  const waveWash = Fn(([p]) => {
    const age = beachPhase(p).sub(Math.PI / 2).div(Math.PI * 2).fract();
    return distance(p).smoothstep(-12, -1).mul(age.mul(rain.mul(2).sub(4)).exp().max(age.smoothstep(0.88, 1)));
  });
  const baseMoisture = Fn(([p]) => distance(p).smoothstep(-32, 0).mul(0.55));
  return { distance, depth, beachPhase, waveWash, baseMoisture };
}

export function advanceBeachMoisture(moisture, rain, delta) {
  if (!Number.isFinite(delta) || delta <= 0) return moisture;
  const target = MathUtils.clamp(rain, 0, 1);
  const seconds = target > moisture ? 18 : 100;
  return MathUtils.lerp(moisture, target, -Math.expm1(-delta / seconds));
}
