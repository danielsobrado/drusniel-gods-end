import { Fn, float, mix, normalize, sin, vec2, vec3 } from 'three/tsl';
import { createCoastNodes } from '../world/CoastField.js';
import { resolveSeaWaves, SEA_COMPONENTS, SEA_STORM_SCALE } from './seaWaves.js';

const NORMAL_STEP = 0.25;

export function createSeaNodes(sea, clock, rain) {
  const params = resolveSeaWaves(sea);
  const coast = createCoastNodes(params, clock, rain);
  const offshore = Fn(([p]) => coast.distance(p).smoothstep(params.transitionStart, params.transitionEnd));
  const amplitude = Fn(([p]) => mix(float(params.beachAmplitude), float(params.offshoreAmplitude), offshore(p))
    .mul(rain.mul(SEA_STORM_SCALE - 1).add(1))
    .min(coast.depth(p).mul(0.42))
    .mul(coast.depth(p).smoothstep(0, 0.15)));
  const shape = Fn(([phase, sharpness]) => {
    const s = sin(phase).toVar();
    return s.add(s.mul(s).sub(0.5).mul(sharpness)).div(sharpness.mul(0.5).add(1));
  });
  const height = Fn(([p]) => {
    const swell = float(0).toVar();
    for (const wave of SEA_COMPONENTS) {
      const phase = p.x.mul(wave.x).add(p.y.mul(wave.z)).mul(wave.frequency)
        .add(clock.mul(wave.speed)).add(wave.phase);
      swell.addAssign(shape(
        phase,
        rain.mul(0.5).add(1).mul(params.choppiness * 0.075),
      ).mul(wave.weight));
    }
    return mix(
      shape(coast.beachPhase(p), rain.mul(0.2).add(0.45)),
      swell,
      offshore(p),
    ).mul(amplitude(p));
  });
  const normal = Fn(([p]) => {
    const h = height(p).toVar();
    const dx = height(p.add(vec2(NORMAL_STEP, 0))).sub(h).div(NORMAL_STEP);
    const dz = height(p.add(vec2(0, NORMAL_STEP))).sub(h).div(NORMAL_STEP);
    return normalize(vec3(dx.negate(), 1, dz.negate()));
  });
  const crest = Fn(([p]) => height(p).div(amplitude(p).max(0.001)));
  return {
    ...coast,
    height,
    normal,
    offshore,
    amplitude,
    crest,
    params,
  };
}
