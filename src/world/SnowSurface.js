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
const DEFORMATION_NEUTRAL = 128 / 255;
// Camera distances (world units) over which the fine ripple lattice and the
// larger sastrugi lattice fade out, so distant slopes read as smooth snow.
const RIPPLE_FADE_START = 45;
const RIPPLE_FADE_END = 120;
const SASTRUGI_FADE_START = 160;
const SASTRUGI_FADE_END = 420;
const BREAKUP_START = 0.18;
const BREAKUP_FULL = 0.82;
const BREAKUP_MINIMUM = 0.06;
const PRIMARY_MACRO_WARP = 0.28;
const SECONDARY_MACRO_SCALE = 1.73;
const SECONDARY_CROSS_SCALE = 0.61;
const BREAKUP_CROSS_SCALE = 2.17;
const BREAKUP_WARP_SCALE = 0.21;
const JITTER_ALONG_SCALE = 0.47;
const JITTER_CROSS_SCALE = 1.31;
const JITTER_STRENGTH = 0.28;
const SECONDARY_WARP_SCALE = 0.45;
const SECONDARY_MACRO_SCALE_FACTOR = 0.37;
const SECONDARY_JITTER_SCALE = 0.63;
const RIPPLE_CROSS_WARP = 0.75;
const RIPPLE_JITTER_SCALE = 0.31;
const ROUGHNESS_SASTRUGI_WEIGHT = 0.72;
const ROUGHNESS_RIPPLE_WEIGHT = 1 - ROUGHNESS_SASTRUGI_WEIGHT;

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

function deformationAppearance(config) {
  if (config?.enabled === false) {
    return { normalStrength: 0, darkenStrength: 0, bermLighten: 0 };
  }
  return {
    normalStrength: finiteNumber(config?.normalStrength, 'ground.snow.deformation.normalStrength'),
    darkenStrength: finiteNumber(config?.darkenStrength, 'ground.snow.deformation.darkenStrength'),
    bermLighten: finiteNumber(config?.bermLighten, 'ground.snow.deformation.bermLighten'),
  };
}

export function resolveSnowConfig(config) {
  if (!config) throw new Error('ground.snow configuration is required.');
  const angle = finiteNumber(config.wind.angleDegrees, 'ground.snow.wind.angleDegrees') * Math.PI / 180;
  const grainFadeStart = finiteNumber(config.grain.fadeStart, 'ground.snow.grain.fadeStart');
  const grainFadeEnd = finiteNumber(config.grain.fadeEnd, 'ground.snow.grain.fadeEnd');
  if (!(grainFadeEnd > grainFadeStart)) {
    throw new Error('ground.snow.grain.fadeEnd must be greater than ground.snow.grain.fadeStart.');
  }
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
      macroFrequency: positiveNumber(config.sastrugi.macroFrequency, 'ground.snow.sastrugi.macroFrequency'),
      macroCrossFrequency: positiveNumber(config.sastrugi.macroCrossFrequency, 'ground.snow.sastrugi.macroCrossFrequency'),
      macroWarp: finiteNumber(config.sastrugi.macroWarp, 'ground.snow.sastrugi.macroWarp'),
      amplitudeVariation: finiteNumber(config.sastrugi.amplitudeVariation, 'ground.snow.sastrugi.amplitudeVariation'),
      amplitude: finiteNumber(config.sastrugi.amplitude, 'ground.snow.sastrugi.amplitude'),
      secondaryFrequency: positiveNumber(config.sastrugi.secondaryFrequency, 'ground.snow.sastrugi.secondaryFrequency'),
      secondaryAmplitude: finiteNumber(config.sastrugi.secondaryAmplitude, 'ground.snow.sastrugi.secondaryAmplitude'),
    },
    ripples: {
      frequency: positiveNumber(config.ripples.frequency, 'ground.snow.ripples.frequency'),
      crossFrequency: positiveNumber(config.ripples.crossFrequency, 'ground.snow.ripples.crossFrequency'),
      macroFrequency: positiveNumber(config.ripples.macroFrequency, 'ground.snow.ripples.macroFrequency'),
      macroWarp: finiteNumber(config.ripples.macroWarp, 'ground.snow.ripples.macroWarp'),
      amplitude: finiteNumber(config.ripples.amplitude, 'ground.snow.ripples.amplitude'),
    },
    grain: {
      frequencyX: positiveNumber(config.grain.frequencyX, 'ground.snow.grain.frequencyX'),
      frequencyZ: positiveNumber(config.grain.frequencyZ, 'ground.snow.grain.frequencyZ'),
      amplitude: finiteNumber(config.grain.amplitude, 'ground.snow.grain.amplitude'),
      fadeStart: grainFadeStart,
      fadeEnd: grainFadeEnd,
    },
    colors: config.colors,
    surfaceTone: {
      sastrugiContrast: finiteNumber(config.surfaceTone.sastrugiContrast, 'ground.snow.surfaceTone.sastrugiContrast'),
      rippleContrast: finiteNumber(config.surfaceTone.rippleContrast, 'ground.snow.surfaceTone.rippleContrast'),
      exposureContrast: finiteNumber(config.surfaceTone.exposureContrast, 'ground.snow.surfaceTone.exposureContrast'),
    },
    roughness: {
      base: finiteNumber(config.roughness.base, 'ground.snow.roughness.base'),
      compressed: finiteNumber(config.roughness.compressed, 'ground.snow.roughness.compressed'),
      berm: finiteNumber(config.roughness.berm, 'ground.snow.roughness.berm'),
      variation: finiteNumber(config.roughness.variation, 'ground.snow.roughness.variation'),
    },
    lighting: config.lighting,
    deformation: deformationAppearance(config.deformation),
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

  const sastrugiMacro = sin(along.mul(snow.sastrugi.macroFrequency)
    .add(sin(across.mul(snow.sastrugi.macroCrossFrequency))
      .mul(snow.sastrugi.macroWarp * PRIMARY_MACRO_WARP)));
  const breakupA = sin(along.mul(snow.sastrugi.macroFrequency * SECONDARY_MACRO_SCALE)
    .sub(across.mul(snow.sastrugi.macroCrossFrequency * SECONDARY_CROSS_SCALE))
    .add(sastrugiMacro));
  const breakupB = sin(across.mul(snow.sastrugi.macroCrossFrequency * BREAKUP_CROSS_SCALE)
    .add(along.mul(snow.sastrugi.macroFrequency * JITTER_ALONG_SCALE))
    .add(sastrugiMacro.mul(snow.sastrugi.macroWarp * BREAKUP_WARP_SCALE)));
  const breakup = breakupA.mul(breakupB).mul(0.5).add(0.5).clamp(0, 1);
  const breakupEnvelope = smoothstep(BREAKUP_START, BREAKUP_FULL, breakup);
  const phaseJitter = breakupB.mul(snow.sastrugi.macroWarp * BREAKUP_WARP_SCALE)
    .add(sin(along.mul(snow.sastrugi.macroFrequency * JITTER_ALONG_SCALE)
      .add(across.mul(snow.sastrugi.macroCrossFrequency * JITTER_CROSS_SCALE)))
      .mul(snow.sastrugi.macroWarp * JITTER_STRENGTH));

  const sastrugiAmplitude = mix(
    1 - snow.sastrugi.amplitudeVariation,
    1 + snow.sastrugi.amplitudeVariation,
    sastrugiMacro.mul(0.5).add(0.5),
  ).mul(mix(BREAKUP_MINIMUM, 1, breakupEnvelope));
  const sastrugiPhase = along.mul(snow.sastrugi.frequency)
    .add(sin(across.mul(snow.sastrugi.crossFrequency)).mul(snow.sastrugi.warp))
    .add(sastrugiMacro.mul(snow.sastrugi.macroWarp))
    .add(phaseJitter);
  const sastrugiDerivative = shiftedCos(sastrugiPhase)
    .mul(snow.sastrugi.frequency * snow.sastrugi.amplitude)
    .mul(sastrugiAmplitude);
  const sastrugiCrossDerivative = shiftedCos(sastrugiPhase)
    .mul(shiftedCos(across.mul(snow.sastrugi.crossFrequency)))
    .mul(snow.sastrugi.crossFrequency * snow.sastrugi.warp * snow.sastrugi.amplitude)
    .mul(sastrugiAmplitude);
  const secondaryPhase = along.mul(snow.sastrugi.secondaryFrequency)
    .add(sin(across.mul(snow.sastrugi.crossFrequency * SECONDARY_MACRO_SCALE))
      .mul(snow.sastrugi.warp * SECONDARY_WARP_SCALE))
    .sub(sastrugiMacro.mul(snow.sastrugi.macroWarp * SECONDARY_MACRO_SCALE_FACTOR))
    .sub(phaseJitter.mul(SECONDARY_JITTER_SCALE));
  const secondaryDerivative = shiftedCos(secondaryPhase)
    .mul(snow.sastrugi.secondaryFrequency * snow.sastrugi.secondaryAmplitude)
    .mul(sastrugiAmplitude);

  const rippleMacro = sin(along.mul(snow.ripples.macroFrequency)
    .sub(across.mul(snow.ripples.macroFrequency * SECONDARY_CROSS_SCALE))
    .add(breakupA.mul(snow.ripples.macroWarp * PRIMARY_MACRO_WARP)));
  const ripplePhase = along.mul(snow.ripples.frequency)
    .add(sin(across.mul(snow.ripples.crossFrequency)).mul(RIPPLE_CROSS_WARP))
    .add(rippleMacro.mul(snow.ripples.macroWarp))
    .add(phaseJitter.mul(RIPPLE_JITTER_SCALE));
  const rippleEnvelope = mix(BREAKUP_MINIMUM, 1, breakup.oneMinus());
  const rippleAlong = shiftedCos(ripplePhase)
    .mul(snow.ripples.frequency * snow.ripples.amplitude)
    .mul(rippleEnvelope);
  const rippleAcross = shiftedCos(ripplePhase)
    .mul(shiftedCos(across.mul(snow.ripples.crossFrequency)))
    .mul(snow.ripples.crossFrequency * RIPPLE_CROSS_WARP * snow.ripples.amplitude)
    .mul(rippleEnvelope);

  const viewDistance = cameraPosition.distance(positionWorld);
  const grainFade = viewDistance.smoothstep(snow.grain.fadeStart, snow.grain.fadeEnd).oneMinus();
  // The ripple and sastrugi lattices are sine patterns; past their fade
  // distance they alias into a repetitive moire on far slopes, so they fade
  // out with distance like the grain does.
  const rippleFade = viewDistance.smoothstep(RIPPLE_FADE_START, RIPPLE_FADE_END).oneMinus();
  const sastrugiFade = viewDistance.smoothstep(SASTRUGI_FADE_START, SASTRUGI_FADE_END).oneMinus();
  const grainPhaseX = along.mul(snow.grain.frequencyX)
    .add(across.mul(snow.grain.frequencyZ * SECONDARY_WARP_SCALE));
  const grainPhaseZ = across.mul(snow.grain.frequencyZ)
    .sub(along.mul(snow.grain.frequencyX * SECONDARY_MACRO_SCALE_FACTOR));
  const grainX = sin(grainPhaseX)
    .mul(sin(grainPhaseZ.mul(RIPPLE_CROSS_WARP)))
    .mul(snow.grain.amplitude).mul(grainFade);
  const grainZ = sin(grainPhaseZ)
    .mul(sin(grainPhaseX.mul(SECONDARY_JITTER_SCALE)))
    .mul(snow.grain.amplitude).mul(grainFade);

  let deform = vec4(0, 0, DEFORMATION_NEUTRAL, DEFORMATION_NEUTRAL);
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
  const deformGradient = vec2(deform.z.sub(DEFORMATION_NEUTRAL), deform.w.sub(DEFORMATION_NEUTRAL))
    .mul(2).mul(deformInside).mul(snow.deformation.normalStrength);

  const alongGradient = sastrugiDerivative.add(secondaryDerivative).mul(sastrugiFade).add(rippleAlong.mul(rippleFade));
  const acrossGradient = sastrugiCrossDerivative.mul(sastrugiFade).add(rippleAcross.mul(rippleFade));
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
  const rawSastrugiPattern = sin(sastrugiPhase).mul(0.5)
    .add(sin(secondaryPhase).mul(0.25))
    .add(sastrugiMacro.mul(0.15))
    .add(breakupA.mul(0.1)).mul(0.5).add(0.5).clamp(0, 1);
  // The tone patterns share the lattices' distance fades; otherwise the colour
  // contrast alone keeps striping far slopes after the normals have smoothed.
  const sastrugiPattern = mix(0.5, rawSastrugiPattern, sastrugiAmplitude.clamp(0, 1).mul(sastrugiFade));
  const rawRipplePattern = sin(ripplePhase).mul(0.65)
    .add(rippleMacro.mul(0.35)).mul(0.5).add(0.5).clamp(0, 1);
  const ripplePattern = mix(0.5, rawRipplePattern, rippleEnvelope.clamp(0, 1).mul(rippleFade));
  const sastrugiTone = mix(
    1 - snow.surfaceTone.sastrugiContrast,
    1 + snow.surfaceTone.sastrugiContrast,
    sastrugiPattern,
  );
  const rippleTone = mix(
    1 - snow.surfaceTone.rippleContrast,
    1 + snow.surfaceTone.rippleContrast,
    ripplePattern,
  );
  const exposureTone = mix(
    1 - snow.surfaceTone.exposureContrast,
    1 + snow.surfaceTone.exposureContrast,
    exposure,
  );
  const upward = normalWorld.y.max(0).smoothstep(0.35, 0.95);
  const baseColor = mix(color(snow.colors.shadow), color(snow.colors.base), upward)
    .mul(driftTone)
    .mul(sastrugiTone)
    .mul(rippleTone)
    .mul(exposureTone)
    .mul(depression.mul(snow.deformation.darkenStrength).oneMinus());
  const snowColor = mix(baseColor, color(snow.colors.sun), berm.mul(snow.deformation.bermLighten).clamp(0, 1));

  const viewDirection = normalize(cameraPosition.sub(positionWorld));
  const halfVector = normalize(viewDirection.add(foliageLight.direction));
  const sparkle = sin(grainPhaseX.mul(Number(snow.lighting.sparkleFrequency) / snow.grain.frequencyX))
    .mul(sin(grainPhaseZ.mul(Number(snow.lighting.sparkleFrequency) / snow.grain.frequencyZ)))
    .mul(0.5).add(0.5);
  const glint = dot(snowWorldNormal, halfVector).max(0)
    .pow(Number(snow.lighting.glintPower))
    .mul(sparkle.pow(6))
    .mul(Number(snow.lighting.glintStrength))
    .mul(foliageLight.strength)
    // Sparkle is a near-field effect; unfaded, its sine product aliases into
    // a diagonal lattice across distant sun-facing slopes.
    .mul(grainFade)
    .mul(mask);
  const backscatter = dot(viewDirection, foliageLight.direction.negate()).max(0)
    .pow(Number(snow.lighting.backscatterPower))
    .mul(Number(snow.lighting.sssStrength))
    .mul(foliageLight.strength)
    .mul(mask);
  const emissive = foliageLight.color.mul(glint)
    .add(color(snow.colors.shadow).mul(backscatter).mul(foliageLight.color));

  const compressed = depression.max(berm.mul(0.2)).clamp(0, 1);
  const windPattern = sastrugiPattern.mul(ROUGHNESS_SASTRUGI_WEIGHT)
    .add(ripplePattern.mul(ROUGHNESS_RIPPLE_WEIGHT));
  const windRoughness = mix(
    snow.roughness.base - snow.roughness.variation,
    snow.roughness.base + snow.roughness.variation,
    windPattern,
  ).clamp(0, 1);
  const roughness = mix(windRoughness, snow.roughness.compressed, compressed);
  const bermRoughness = mix(roughness, snow.roughness.berm, berm);

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
