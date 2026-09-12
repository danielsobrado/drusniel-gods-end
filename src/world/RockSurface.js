import {
  cameraViewMatrix,
  color,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  sin,
  texture,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number.`);
  return number;
}

function positiveNumber(value, name) {
  const number = finiteNumber(value, name);
  if (!(number > 0)) throw new Error(`${name} must be greater than zero.`);
  return number;
}

function interval(value, name) {
  if (!value || typeof value !== 'object') throw new Error(`${name} configuration is required.`);
  const start = finiteNumber(value.start, `${name}.start`);
  const full = finiteNumber(value.full, `${name}.full`);
  if (!(full > start)) throw new Error(`${name}.full must be greater than ${name}.start.`);
  return { start, full };
}

export function resolveRockSurfaceConfig(config) {
  const rock = config?.ground?.rock;
  if (!rock) throw new Error('ground.rock configuration is required.');
  return {
    highland: interval(rock.highland, 'ground.rock.highland'),
    cliffSlope: interval(rock.cliffSlope, 'ground.rock.cliffSlope'),
    cliffAltitude: interval(rock.cliffAltitude, 'ground.rock.cliffAltitude'),
    highlandStrength: finiteNumber(rock.highlandStrength, 'ground.rock.highlandStrength'),
    cliffStrength: finiteNumber(rock.cliffStrength, 'ground.rock.cliffStrength'),
    riverBankStrength: finiteNumber(rock.riverBankStrength, 'ground.rock.riverBankStrength'),
    lakeBedStrength: finiteNumber(rock.lakeBedStrength, 'ground.rock.lakeBedStrength'),
    rockyArea: {
      center: vec2(
        finiteNumber(rock.rockyArea.center[0], 'ground.rock.rockyArea.center[0]'),
        finiteNumber(rock.rockyArea.center[1], 'ground.rock.rockyArea.center[1]'),
      ),
      radius: vec2(
        positiveNumber(rock.rockyArea.radius[0], 'ground.rock.rockyArea.radius[0]'),
        positiveNumber(rock.rockyArea.radius[1], 'ground.rock.rockyArea.radius[1]'),
      ),
      inner: finiteNumber(rock.rockyArea.inner, 'ground.rock.rockyArea.inner'),
      outer: finiteNumber(rock.rockyArea.outer, 'ground.rock.rockyArea.outer'),
      strength: finiteNumber(rock.rockyArea.strength, 'ground.rock.rockyArea.strength'),
    },
    triplanarScale: positiveNumber(rock.triplanarScale, 'ground.rock.triplanarScale'),
    triplanarSharpness: positiveNumber(rock.triplanarSharpness, 'ground.rock.triplanarSharpness'),
    textureStrength: finiteNumber(rock.textureStrength, 'ground.rock.textureStrength'),
    textureBias: finiteNumber(rock.textureBias, 'ground.rock.textureBias'),
    grainFrequencyX: positiveNumber(rock.grainFrequencyX, 'ground.rock.grainFrequencyX'),
    grainFrequencyZ: positiveNumber(rock.grainFrequencyZ, 'ground.rock.grainFrequencyZ'),
    grainWarpFrequency: positiveNumber(rock.grainWarpFrequency, 'ground.rock.grainWarpFrequency'),
    grainAmplitude: finiteNumber(rock.grainAmplitude, 'ground.rock.grainAmplitude'),
    strataFrequency: positiveNumber(rock.strataFrequency, 'ground.rock.strataFrequency'),
    strataMacroInfluence: finiteNumber(rock.strataMacroInfluence, 'ground.rock.strataMacroInfluence'),
    strataAmplitude: finiteNumber(rock.strataAmplitude, 'ground.rock.strataAmplitude'),
    normalFrequency: vec3(
      positiveNumber(rock.normalFrequency[0], 'ground.rock.normalFrequency[0]'),
      positiveNumber(rock.normalFrequency[1], 'ground.rock.normalFrequency[1]'),
      positiveNumber(rock.normalFrequency[2], 'ground.rock.normalFrequency[2]'),
    ),
    normalStrength: finiteNumber(rock.normalStrength, 'ground.rock.normalStrength'),
    dryRoughness: finiteNumber(rock.dryRoughness, 'ground.rock.dryRoughness'),
    wetRoughness: finiteNumber(rock.wetRoughness, 'ground.rock.wetRoughness'),
    roughnessTextureStrength: finiteNumber(rock.roughnessTextureStrength, 'ground.rock.roughnessTextureStrength'),
    colors: {
      shadow: rock.colors.shadow,
      sun: rock.colors.sun,
      lake: rock.colors.lake,
    },
    lakeColorStrength: finiteNumber(rock.lakeColorStrength, 'ground.rock.lakeColorStrength'),
    wetDarkening: finiteNumber(rock.wetDarkening, 'ground.rock.wetDarkening'),
  };
}

function triplanar(textureObject, scale, weights) {
  const world = positionWorld;
  const x = texture(textureObject, world.yz.mul(scale));
  const y = texture(textureObject, world.xz.mul(scale));
  const z = texture(textureObject, world.xy.mul(scale));
  const denominator = weights.x.add(weights.y).add(weights.z).max(0.001);
  return x.mul(weights.x).add(y.mul(weights.y)).add(z.mul(weights.z)).div(denominator);
}

export function createRockSurfaceNodes({ config, colorTexture, roughnessTexture, macro, wet, riverBank, lakeBed }) {
  const rock = resolveRockSurfaceConfig(config);
  const world = positionWorld.xz;
  const highland = positionWorld.y.smoothstep(rock.highland.start, rock.highland.full);
  const cliff = normalWorld.y.abs().smoothstep(rock.cliffSlope.start, rock.cliffSlope.full).oneMinus();
  const cliffAltitude = positionWorld.y.smoothstep(rock.cliffAltitude.start, rock.cliffAltitude.full);
  const rockyArea = world.sub(rock.rockyArea.center).div(rock.rockyArea.radius).length()
    .smoothstep(rock.rockyArea.inner, rock.rockyArea.outer).oneMinus();
  const mask = highland.mul(rock.highlandStrength)
    .max(cliff.mul(cliffAltitude).mul(rock.cliffStrength))
    .max(riverBank.mul(rock.riverBankStrength))
    .max(rockyArea.mul(rock.rockyArea.strength))
    .max(lakeBed.mul(rock.lakeBedStrength))
    .clamp(0, 1);

  const weights = normalWorld.abs().pow(rock.triplanarSharpness);
  const stoneTexture = triplanar(colorTexture, rock.triplanarScale, weights).rgb;
  const roughnessSample = triplanar(roughnessTexture, rock.triplanarScale, weights).r;
  const grains = sin(world.x.mul(rock.grainFrequencyX)
    .add(sin(world.y.mul(rock.grainWarpFrequency))))
    .mul(sin(world.y.mul(rock.grainFrequencyZ)))
    .mul(rock.grainAmplitude).add(1 - rock.grainAmplitude);
  const strata = sin(positionWorld.y.mul(rock.strataFrequency)
    .add(macro.mul(rock.strataMacroInfluence)))
    .mul(rock.strataAmplitude).add(1 - rock.strataAmplitude);
  const baseColor = mix(
    mix(color(rock.colors.shadow), color(rock.colors.sun), macro),
    color(rock.colors.lake),
    lakeBed.mul(rock.lakeColorStrength),
  );
  const surfaceColor = baseColor
    .mul(stoneTexture.mul(rock.textureStrength).add(rock.textureBias))
    .mul(grains)
    .mul(strata)
    .mul(wet.mul(rock.wetDarkening).oneMinus());

  const normalDetail = vec3(
    sin(positionWorld.y.mul(rock.normalFrequency.x).add(positionWorld.z.mul(rock.normalFrequency.z))),
    sin(positionWorld.x.mul(rock.normalFrequency.y).add(positionWorld.z.mul(rock.normalFrequency.x))).mul(0.35),
    sin(positionWorld.y.mul(rock.normalFrequency.z).sub(positionWorld.x.mul(rock.normalFrequency.y))),
  ).mul(rock.normalStrength).mul(mask);
  const surfaceNormal = normalize(
    cameraViewMatrix.mul(vec4(normalize(normalWorld.add(normalDetail)), 0)).xyz,
  );
  const sampledRoughness = mix(rock.dryRoughness, roughnessSample, rock.roughnessTextureStrength);
  const surfaceRoughness = mix(sampledRoughness, rock.wetRoughness, wet);

  return { mask, color: surfaceColor, normal: surfaceNormal, roughness: surfaceRoughness };
}
