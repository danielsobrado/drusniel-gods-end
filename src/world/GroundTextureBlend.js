import {
  mix,
  positionWorld,
  sin,
  texture,
  vec2,
} from 'three/tsl';

function finiteNumber(value, name, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} must be a finite number in [${min}, ${max}].`);
  }
  return number;
}

function positiveNumber(value, name) {
  const number = finiteNumber(value, name);
  if (!(number > 0)) throw new Error(`${name} must be greater than zero.`);
  return number;
}

export function resolveGroundAntiTilingConfig(config) {
  const antiTiling = config?.ground?.antiTiling;
  if (!antiTiling) throw new Error('ground.antiTiling configuration is required.');
  if (!Array.isArray(antiTiling.offset) || antiTiling.offset.length !== 2) {
    throw new Error('ground.antiTiling.offset must contain two numbers.');
  }
  const blendStart = finiteNumber(antiTiling.blendStart, 'ground.antiTiling.blendStart', { min: 0, max: 1 });
  const blendEnd = finiteNumber(antiTiling.blendEnd, 'ground.antiTiling.blendEnd', { min: 0, max: 1 });
  if (!(blendEnd > blendStart)) {
    throw new Error('ground.antiTiling.blendEnd must be greater than ground.antiTiling.blendStart.');
  }
  return {
    enabled: antiTiling.enabled !== false,
    secondaryScale: positiveNumber(antiTiling.secondaryScale, 'ground.antiTiling.secondaryScale'),
    offset: [
      finiteNumber(antiTiling.offset[0], 'ground.antiTiling.offset[0]'),
      finiteNumber(antiTiling.offset[1], 'ground.antiTiling.offset[1]'),
    ],
    macroFrequencyX: positiveNumber(antiTiling.macroFrequencyX, 'ground.antiTiling.macroFrequencyX'),
    macroFrequencyZ: positiveNumber(antiTiling.macroFrequencyZ, 'ground.antiTiling.macroFrequencyZ'),
    warpFrequency: positiveNumber(antiTiling.warpFrequency, 'ground.antiTiling.warpFrequency'),
    warpStrength: finiteNumber(antiTiling.warpStrength, 'ground.antiTiling.warpStrength', { min: 0 }),
    blendStart,
    blendEnd,
    colorVariation: finiteNumber(antiTiling.colorVariation, 'ground.antiTiling.colorVariation', { min: 0, max: 0.25 }),
    roughnessVariation: finiteNumber(antiTiling.roughnessVariation, 'ground.antiTiling.roughnessVariation', { min: 0, max: 0.25 }),
  };
}

export function createGroundTextureSamples({ config, colorTexture, normalTexture, roughnessTexture, primaryUv }) {
  const antiTiling = resolveGroundAntiTilingConfig(config);
  const colorPrimary = texture(colorTexture, primaryUv);
  const normalPrimary = texture(normalTexture, primaryUv);
  const roughnessPrimary = texture(roughnessTexture, primaryUv).r;
  if (!antiTiling.enabled) {
    return { color: colorPrimary, normal: normalPrimary, roughness: roughnessPrimary };
  }

  const secondaryUv = primaryUv.mul(antiTiling.secondaryScale)
    .add(vec2(antiTiling.offset[0], antiTiling.offset[1]));
  const colorSecondary = texture(colorTexture, secondaryUv);
  const normalSecondary = texture(normalTexture, secondaryUv);
  const roughnessSecondary = texture(roughnessTexture, secondaryUv).r;
  const world = positionWorld.xz;
  const macro = sin(
    world.x.mul(antiTiling.macroFrequencyX)
      .add(sin(world.y.mul(antiTiling.warpFrequency)).mul(antiTiling.warpStrength)),
  ).mul(sin(
    world.y.mul(antiTiling.macroFrequencyZ)
      .add(sin(world.x.mul(antiTiling.warpFrequency * 1.37)).mul(antiTiling.warpStrength * 0.63)),
  )).mul(0.5).add(0.5);
  const blend = macro.smoothstep(antiTiling.blendStart, antiTiling.blendEnd);
  const tone = mix(1 - antiTiling.colorVariation, 1 + antiTiling.colorVariation, macro);
  const roughnessOffset = macro.sub(0.5).mul(antiTiling.roughnessVariation * 2);

  return {
    color: mix(colorPrimary, colorSecondary, blend).mul(tone),
    normal: mix(normalPrimary, normalSecondary, blend),
    roughness: mix(roughnessPrimary, roughnessSecondary, blend).add(roughnessOffset).clamp(0, 1),
  };
}
