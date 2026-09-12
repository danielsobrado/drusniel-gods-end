import {
  cameraPosition,
  cameraViewMatrix,
  color,
  dot,
  float,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { foliageLight } from '../rendering/CinematicLighting.js';

const HALF_PI = Math.PI * 0.5;

function positiveNumber(value, name) {
  const number = Number(value);
  if (!(number > 0) || !Number.isFinite(number)) throw new Error(`${name} must be a positive finite number.`);
  return number;
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number.`);
  return number;
}

function interval(value, name) {
  if (!value || typeof value !== 'object') throw new Error(`${name} configuration is required.`);
  const start = finiteNumber(value.start, `${name}.start`);
  const full = finiteNumber(value.full, `${name}.full`);
  if (!(full > start)) throw new Error(`${name}.full must be greater than ${name}.start.`);
  return { start, full };
}

export function resolveSnowConfig(config) {
  if (!config) throw new Error('ground.snow configuration is required.');
  const angle = finiteNumber(config.wind.angleDegrees, 'ground.snow.wind.angleDegrees') * Math.PI / 180;
  return {
    enabled: config.enabled !== false,
    altitude: interval(config.altitude, 'ground.snow.altitude'),
    slope: interval(config.slope, 'ground.snow.slope'),
    wind: {
      cos: Math.cos(angle),
      sin: Math.sin(angle),
      driftFrequency: positiveNumber(config.wind.driftFrequency, 'ground.snow.wind.driftFrequency'),
      crossFrequency: positiveNumber(config.wind.crossFrequency, 'ground.snow.wind.crossFrequency'),
      exposureFrequency: positiveNumber(config.wind.exposureFrequency, 'ground.snow.wind.exposureFrequency'),
      exposureCrossFrequency: positiveNumber(config.wind.exposureCrossFrequency, 'ground.snow.wind.exposureCrossFrequency'),
      warp: finiteNumber(config.wind.warp, 'ground.snow.wind.warp'),
      driftHeight: finiteNumber(config.wind.driftHeight, 'ground.snow.wind.driftHeight'),
      scourStrength: finiteNumber(config.wind.scourStrength, 'ground.snow.wind.scourStrength'),
    },
    sastrugi: {
      frequency: positiveNumber(config.sastrugi.frequency, 'ground.snow.sastrugi.frequency'),
      crossFrequency: positiveNumber(config.sastrugi.crossFrequency, 'ground.snow.sastrugi.crossFrequency'),
      warp: finiteNumber(config.sastrugi.warp, 'ground.snow.sastrugi.warp'),
      amplitude: finiteNumber(config.sastrugi.amplitude, 'ground.snow.sastrugi.amplitude'),
      secondaryFrequency: positiveNumber(config.sastrugi.secondaryFrequency, 'ground.snow.sastrugi.secondaryFrequency'),
      secondaryAmplitude: finiteNumber(config.sastrugi.secondaryAmplitude, 'ground.snow.sastrugi.secondaryAmplitude'),
    },
    ripples: {
      frequency: positiveNumber(config.ripples.frequency, 'ground.snow.ripples.frequency'),
      crossFrequency: positiveNumber(config.ripples.crossFrequency, 'ground.snow.ripples.crossFrequency'),
      amplitude: finiteNumber(config.ripples.amplitude, 'ground.snow.ripples.amplitude'),
    },
    grain: {
      frequencyX: positiveNumber(config.grain.frequencyX, 'ground.snow.grain.frequencyX'),
      frequencyZ: positiveNumber(config.grain.frequencyZ, 'ground.snow.grain.frequencyZ'),
      amplitude: finiteNumber(config.grain.amplitude, 'ground.snow.grain.amplitude'),
      fadeStart: finiteNumber(config.grain.fadeStart, 'ground.snow.grain.fadeStart'),
      fadeEnd: finiteNumber(config.grain.fadeEnd, 'ground.snow.grain.fadeEnd'),
    },
    colors: config.colors,
    roughness: config.roughness,
    lighting: config.lighting,
    deformation: config.deformation,
  };
}

function shiftedCos(phase) {
  return sin(phase.add(HALF_PI));
}

function windCoordinates(world, snow) {
  const along = world.x.mul(snow.wind.cos).add(world.y.mul(snow.wind.sin));
  const across = world.x.mul(-snow.wind.sin).add(world.y.mul(snow.wind.cos));
  return { along, across };
}

export function createSnowSurfaceNodes(config, deformationField = null) {
  const snow = resolveSnowConfig(config.ground.snow);
  const world = positionWorld.xz;
  const { along, across } = windCoordinates(world, snow);

  const driftPhase = along.mul(snow.wind.driftFrequency)
    .add(sin(across.mul(snow.wind.crossFrequency)).mul(snow.wind.warp));
  const drift = sin(driftPhase).mul(0.5).add(0.5);
  const exposure = sin(along.mul(snow.wind.exposureFrequency)
    .sub(across.mul(snow.wind.exposureCrossFrequency))).mul(0.5).add(0.5);
  const effectiveHeight = positionWorld.y
    .add(drift.mul(snow.wind.driftHeight))
    .sub(exposure.mul(snow.wind.scourStrength));
  const altitude = smoothstep(snow.altitude.start, snow.altitude.full, effectiveHeight);
  const slope = smoothstep(snow.slope.start, snow.slope.full, normalWorld.y.abs());
  const mask = altitude.mul(slope).clamp(0, 1).toVar();

  const sastrugiPhase = along.mul(snow.sastrugi.frequency)
    .add(sin(across.mul(snow.sastrugi.crossFrequency)).mul(snow.sastrugi.warp));
  const sastrugiDerivative = shiftedCos(sastrugiPhase).mul(snow.sastrugi.frequency * snow.sastrugi.amplitude);
  const sastrugiCrossDerivative = shiftedCos(sastrugiPhase)
    .mul(shiftedCos(across.mul(snow.sastrugi.crossFrequency)))
    .mul(snow.sastrugi.crossFrequency * snow.sastrugi.warp * snow.sastrugi.amplitude);
  const secondaryPhase = along.mul(snow.sastrugi.secondaryFrequency)
    .add(sin(across.mul(snow.sastrugi.crossFrequency * 1.7)).mul(snow.sastrugi.warp * 0.45));
  const secondaryDerivative = shiftedCos(secondaryPhase)
    .mul(snow.sastrugi.secondaryFrequency * snow.sastrugi.secondaryAmplitude);

  const ripplePhase = along.mul(snow.ripples.frequency)
    .add(sin(across.mul(snow.ripples.crossFrequency)).mul(0.75));
  const rippleAlong = shiftedCos(ripplePhase).mul(snow.ripples.frequency * snow.ripples.amplitude);
  const rippleAcross = shiftedCos(ripplePhase)
    .mul(shiftedCos(across.mul(snow.ripples.crossFrequency)))
    .mul(snow.ripples.crossFrequency * 0.75 * snow.ripples.amplitude);

  const grainFade = cameraPosition.distance(positionWorld)
    .smoothstep(snow.grain.fadeStart, snow.grain.fadeEnd).oneMinus();
  const grainX = sin(world.x.mul(snow.grain.frequencyX))
    .mul(snow.grain.amplitude).mul(grainFade);
  const grainZ = sin(world.y.mul(snow.grain.frequencyZ))
    .mul(snow.grain.amplitude).mul(grainFade);

  let deform = vec4(0, 0, 0.5, 0.5);
  let deformInside = float(0);
  if (deformationField?.config?.enabled) {
    const center = uniform(deformationField.center);
    const worldSize = deformationField.config.worldSize;
    const deformationUv = world.sub(center).div(worldSize).add(0.5);
    const insideX = step(float(0), deformationUv.x).mul(step(deformationUv.x, float(1)));
    const insideY = step(float(0), deformationUv.y).mul(step(deformationUv.y, float(1)));
    deformInside = insideX.mul(insideY);
    deform = texture(deformationField.texture, deformationUv.clamp(0, 1));
  }
  const depression = deform.x.mul(deformInside).mul(mask).toVar();
  const berm = deform.y.mul(deformInside).mul(mask).toVar();
  const deformGradient = vec2(deform.z.sub(0.5), deform.w.sub(0.5)).mul(2).mul(deformInside)
    .mul(Number(snow.deformation.normalStrength));

  const alongGradient = sastrugiDerivative.add(secondaryDerivative).add(rippleAlong);
  const acrossGradient = sastrugiCrossDerivative.add(rippleAcross);
  const gradientX = alongGradient.mul(snow.wind.cos).sub(acrossGradient.mul(snow.wind.sin))
    .add(grainX).add(deformGradient.x);
  const gradientZ = alongGradient.mul(snow.wind.sin).add(acrossGradient.mul(snow.wind.cos))
    .add(grainZ).add(deformGradient.y);
  const snowWorldNormal = normalize(normalWorld.add(vec3(gradientX.negate(), 0, gradientZ.negate()).mul(mask))).toVar();
  const snowViewNormal = normalize(cameraViewMatrix.mul(vec4(snowWorldNormal, 0)).xyz).toVar();

  const driftTone = mix(
    1 - Number(snow.colors.driftVariation),
    1 + Number(snow.colors.driftVariation),
    drift,
  );
  const upward = normalWorld.y.max(0).smoothstep(0.35, 0.95);
  const baseColor = mix(color(snow.colors.shadow), color(snow.colors.base), upward)
    .mul(driftTone)
    .mul(depression.mul(Number(snow.deformation.darkenStrength)).oneMinus());
  const snowColor = mix(baseColor, color(snow.colors.sun), berm.mul(Number(snow.deformation.bermLighten)).clamp(0, 1));

  const viewDirection = normalize(cameraPosition.sub(positionWorld));
  const halfVector = normalize(viewDirection.add(foliageLight.direction));
  const sparkle = sin(world.x.mul(Number(snow.lighting.sparkleFrequency))
    .add(sin(world.y.mul(Number(snow.lighting.sparkleFrequency) * 1.37))))
    .mul(sin(world.y.mul(Number(snow.lighting.sparkleFrequency) * 0.83))).mul(0.5).add(0.5);
  const glint = dot(snowWorldNormal, halfVector).max(0)
    .pow(Number(snow.lighting.glintPower))
    .mul(sparkle.pow(6))
    .mul(Number(snow.lighting.glintStrength))
    .mul(foliageLight.strength)
    .mul(mask);
  const backscatter = dot(viewDirection, foliageLight.direction.negate()).max(0)
    .pow(Number(snow.lighting.backscatterPower))
    .mul(Number(snow.lighting.sssStrength))
    .mul(foliageLight.strength)
    .mul(mask);
  const emissive = foliageLight.color.mul(glint)
    .add(color(snow.colors.shadow).mul(backscatter).mul(foliageLight.color));

  const compressed = depression.max(berm.mul(0.2)).clamp(0, 1);
  const roughness = mix(
    Number(snow.roughness.base),
    Number(snow.roughness.compressed),
    compressed,
  );
  const bermRoughness = mix(roughness, Number(snow.roughness.berm), berm);

  return {
    mask,
    color: snowColor,
    normal: snowViewNormal,
    roughness: bermRoughness,
    emissive,
    depression,
    berm,
  };
}
