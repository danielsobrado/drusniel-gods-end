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
  const nearshorePhase = Fn(([p]) => {
    const detail = params.detail;
    const distance = coast.distance(p);
    const spacing = sin(p.y.mul(detail.nearshoreSpacingFrequency))
      .mul(detail.nearshoreSpacingVariation);
    const spatialFrequency = Math.PI * 2 / params.coast.wave.wavelength;
    const spacingOffset = distance.mul(spatialFrequency).mul(spacing);
    const cross = sin(p.y.mul(detail.nearshoreLongFrequency)
      .add(sin(p.y.mul(detail.nearshoreCrossFrequency)).mul(1.7)))
      .mul(detail.nearshoreWarp);
    const counter = sin(p.y.mul(detail.nearshoreCrossFrequency * 0.73)
      .add(sin(p.y.mul(detail.nearshoreLongFrequency * 1.37))))
      .mul(detail.nearshoreWarp * 0.45);
    return coast.beachPhase(p).add(spacingOffset).add(cross).add(counter);
  });
  // Wave sets (seaWaves nearshoreSetEnvelope): a crest's share of full height
  // varies along it and from one wave to the next.
  const setEnvelope = Fn(([p]) => {
    const detail = params.detail;
    const set = sin(coast.beachPhase(p).mul(detail.setGroup).add(p.y.mul(detail.setAlongFrequency))
      .add(sin(p.y.mul(detail.setAlongFrequency * 0.41).add(1.3)).mul(1.6))).mul(0.5).add(0.5);
    return float(1).sub(set.mul(detail.setDepth));
  });
  const height = Fn(([p]) => {
    const swell = float(0).toVar();
    for (const wave of SEA_COMPONENTS) {
      const phase = p.x.mul(wave.x).add(p.y.mul(wave.z)).mul(wave.waveNumber)
        .add(clock.mul(wave.angularSpeed)).add(wave.phase);
      swell.addAssign(shape(
        phase,
        rain.mul(0.5).add(1).mul(params.choppiness * 0.075),
      ).mul(wave.weight));
    }
    return mix(
      shape(nearshorePhase(p), rain.mul(0.2).add(0.45)).mul(setEnvelope(p)),
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
  return {
    ...coast,
    height,
    normal,
    offshore,
    amplitude,
    nearshorePhase,
    setEnvelope,
    params,
  };
}
