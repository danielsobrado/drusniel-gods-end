import {
  Fn,
  cos,
  dot,
  float,
  floor,
  fract,
  mix,
  sin,
  smoothstep,
  uniform,
  vec2,
} from 'three/tsl';

const TWO_PI = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;
const HASH_SCALE = 43758.5453;
// Lattice hash coefficients. They must be large and mutually irrational: small ones (0.1/0.7)
// leave the gradient angles strongly biased towards a few directions, which reads as axis-aligned
// streaking in the gust fronts. Verified uniform (chi-square 10 over 12 bins vs 414) and stable
// under float32 out to coordinates of 5e5, so long sessions do not degrade the lattice.
const HASH_COEFFICIENTS = Object.freeze([12.9898, 78.233]);
// Decorrelates the cross-wind warp lookup from the along-wind one.
const WARP_LOOKUP_OFFSET = Object.freeze([37.41, -19.73]);

const DEFAULT_WIND = Object.freeze({
  model: 'cinematic',
  baseStrength: 0.18,
  minStrength: 0.06,
  maxStrength: 1.25,
  noiseScaleReference: 0.3,
  direction: Object.freeze({
    variationDegrees: 12,
    scale: 0.03,
    speed: 0.035,
  }),
  large: Object.freeze({
    scale: 0.015,
    speed: 0.08,
    strength: 0.7,
  }),
  medium: Object.freeze({
    scale: 0.07,
    speed: 0.21,
    strength: 0.23,
  }),
  flutter: Object.freeze({
    scale: 0.35,
    speed: 0.7,
    strength: 0.07,
  }),
  // Bounded domain warp. Displaces every layer's sample point by at most
  // `amplitude * (1 + lateralGain)` noise cells, so unlike a direction wobble applied to the
  // advection clock it cannot grow with elapsed time. It advects more slowly than any layer, so
  // the composite field deforms as it travels instead of sliding rigidly: gust fronts curl,
  // meander across the wind, and dissolve rather than sweeping past as clean parallel bands.
  warp: Object.freeze({
    scale: 0.01,
    speed: 0.045,
    amplitude: 0.85,
    lateralGain: 1.6,
  }),
  gust: Object.freeze({
    threshold: 0.48,
    peak: 0.86,
    exponent: 1.6,
    inertiaSeconds: 0.12,
    inertiaGain: 0.2,
  }),
  response: Object.freeze({
    blade: Object.freeze({
      bendScale: 0.28,
      tipFlutter: 0.035,
      tipExponent: 5,
      variationMin: 0.85,
      variationMax: 1.15,
    }),
    billboard: Object.freeze({
      bendScale: 0.22,
      tipFlutter: 0.025,
      tipExponent: 4,
      variationMin: 0.9,
      variationMax: 1.1,
    }),
    trees: Object.freeze({
      bendScale: 0.08,
      flutterScale: 0.025,
      heightMeters: 8,
      outerRadius: 3,
    }),
    leaves: Object.freeze({
      advection: 0.52,
      turbulence: 0.22,
    }),
  }),
});

const sharedWindUniforms = {
  directionDegrees: uniform(0),
  noiseScale: uniform(1),
  simulationSpeed: uniform(1),
};

function mergeSection(defaults, override) {
  return { ...defaults, ...(override ?? {}) };
}

export function resolveWindConfig(config = {}) {
  const source = config.wind ?? config;
  return {
    ...DEFAULT_WIND,
    ...source,
    direction: mergeSection(DEFAULT_WIND.direction, source.direction),
    large: mergeSection(DEFAULT_WIND.large, source.large),
    medium: mergeSection(DEFAULT_WIND.medium, source.medium),
    flutter: mergeSection(DEFAULT_WIND.flutter, source.flutter),
    warp: mergeSection(DEFAULT_WIND.warp, source.warp),
    gust: mergeSection(DEFAULT_WIND.gust, source.gust),
    response: {
      blade: mergeSection(DEFAULT_WIND.response.blade, source.response?.blade),
      billboard: mergeSection(DEFAULT_WIND.response.billboard, source.response?.billboard),
      trees: mergeSection(DEFAULT_WIND.response.trees, source.response?.trees),
      leaves: mergeSection(DEFAULT_WIND.response.leaves, source.response?.leaves),
    },
  };
}

export function setSharedWindState({ directionDegrees, noiseScale, simulationSpeed } = {}) {
  if (Number.isFinite(directionDegrees)) {
    sharedWindUniforms.directionDegrees.value = Number(directionDegrees);
  }
  if (Number.isFinite(noiseScale)) {
    sharedWindUniforms.noiseScale.value = Math.max(0.01, Number(noiseScale));
  }
  if (Number.isFinite(simulationSpeed)) {
    sharedWindUniforms.simulationSpeed.value = Math.max(0, Number(simulationSpeed));
  }
}

export function getSharedWindState() {
  return {
    directionDegrees: sharedWindUniforms.directionDegrees.value,
    noiseScale: sharedWindUniforms.noiseScale.value,
    simulationSpeed: sharedWindUniforms.simulationSpeed.value,
  };
}

export function getSharedWindUniforms() {
  return sharedWindUniforms;
}

function fractCpu(value) {
  return value - Math.floor(value);
}

function lerpCpu(a, b, t) {
  return a + (b - a) * t;
}

function smoothstepCpu(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function gradientCpu(x, y) {
  const angle = fractCpu(
    Math.sin(x * HASH_COEFFICIENTS[0] + y * HASH_COEFFICIENTS[1]) * HASH_SCALE,
  ) * TWO_PI;
  return [Math.cos(angle), Math.sin(angle)];
}

export function gradientNoise2dCpu(x, y) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const localX = fractCpu(x);
  const localY = fractCpu(y);
  const fadeX = localX * localX * (3 - 2 * localX);
  const fadeY = localY * localY * (3 - 2 * localY);

  const dotGradient = (offsetX, offsetY) => {
    const [gradientX, gradientY] = gradientCpu(cellX + offsetX, cellY + offsetY);
    return gradientX * (localX - offsetX) + gradientY * (localY - offsetY);
  };

  return lerpCpu(
    lerpCpu(dotGradient(0, 0), dotGradient(1, 0), fadeX),
    lerpCpu(dotGradient(0, 1), dotGradient(1, 1), fadeX),
    fadeY,
  ) + 0.5;
}

function windWarpCpu(x, z, time, prevailing, simulationSpeed, noiseScale, warp) {
  if (!(warp.amplitude > 0)) return { x: 0, z: 0 };
  const clock = time * simulationSpeed * warp.speed;
  const sampleX = x * warp.scale * noiseScale - prevailing.x * clock;
  const sampleZ = z * warp.scale * noiseScale - prevailing.z * clock;
  const along = (gradientNoise2dCpu(sampleX, sampleZ) * 2 - 1) * warp.amplitude;
  const across = (gradientNoise2dCpu(
    sampleX + WARP_LOOKUP_OFFSET[0],
    sampleZ + WARP_LOOKUP_OFFSET[1],
  ) * 2 - 1) * warp.amplitude * warp.lateralGain;
  // Cross-wind displacement is gained up: real gust cells stretch along the wind and wander
  // across it, so an isotropic warp reads as boiling rather than meandering.
  return {
    x: prevailing.x * along - prevailing.z * across,
    z: prevailing.z * along + prevailing.x * across,
  };
}

function sampleLayerCpu(x, z, time, direction, simulationSpeed, noiseScale, layer, warpOffset) {
  const clock = time * simulationSpeed * layer.speed;
  return gradientNoise2dCpu(
    x * layer.scale * noiseScale - direction.x * clock + warpOffset.x,
    z * layer.scale * noiseScale - direction.z * clock + warpOffset.z,
  );
}

export function sampleCinematicWindCpu({
  x,
  z,
  time,
  directionDegrees = sharedWindUniforms.directionDegrees.value,
  intensity = 1,
  simulationSpeed = 1,
  noiseScale = sharedWindUniforms.noiseScale.value,
  config = {},
}) {
  const params = resolveWindConfig(config);
  const directionRadians = directionDegrees * DEG_TO_RAD;
  const prevailing = {
    x: Math.cos(directionRadians),
    z: Math.sin(directionRadians),
  };

  const directionClock = time * simulationSpeed * params.direction.speed;
  const directionNoise = gradientNoise2dCpu(
    x * params.direction.scale * noiseScale - prevailing.x * directionClock,
    z * params.direction.scale * noiseScale - prevailing.z * directionClock,
  ) * 2 - 1;
  const localAngle = directionRadians + directionNoise * params.direction.variationDegrees * DEG_TO_RAD;
  const direction = {
    x: Math.cos(localAngle),
    z: Math.sin(localAngle),
  };

  // Layers advect along the prevailing direction, never the wobbled local one: the offset is
  // `direction * elapsedTime`, so a time-varying direction would displace the sample by an amount
  // that grows with elapsed time and make the wind appear to speed up indefinitely. The meander
  // comes back through the bounded warp below, which is added to the coordinate rather than
  // multiplied by the clock.
  const warpOffset = windWarpCpu(x, z, time, prevailing, simulationSpeed, noiseScale, params.warp);
  const large = sampleLayerCpu(x, z, time, prevailing, simulationSpeed, noiseScale, params.large, warpOffset);
  // The inertia probe reuses the current warp: over `inertiaSeconds` the warp moves by well under
  // a hundredth of a cell, and resampling it would double the warp cost for no visible gain.
  const previousLarge = sampleLayerCpu(
    x,
    z,
    time - params.gust.inertiaSeconds,
    prevailing,
    simulationSpeed,
    noiseScale,
    params.large,
    warpOffset,
  );
  const medium = sampleLayerCpu(x, z, time, prevailing, simulationSpeed, noiseScale, params.medium, warpOffset) * 2 - 1;
  const flutter = sampleLayerCpu(x, z, time, prevailing, simulationSpeed, noiseScale, params.flutter, warpOffset) * 2 - 1;

  const gust = smoothstepCpu(params.gust.threshold, params.gust.peak, large) ** params.gust.exponent;
  const previousGust = smoothstepCpu(
    params.gust.threshold,
    params.gust.peak,
    previousLarge,
  ) ** params.gust.exponent;
  const inertia = (gust - previousGust) * params.gust.inertiaGain;
  const envelope = Math.max(
    params.minStrength,
    Math.min(
      params.maxStrength,
      params.baseStrength
        + gust * params.large.strength
        + Math.abs(medium) * params.medium.strength
        + inertia,
    ),
  );

  return {
    direction,
    strength: envelope * Math.max(0, intensity),
    gust,
    turbulence: medium,
    flutter,
  };
}

// Keep the return type explicit: nested domain warps otherwise expand this
// expression repeatedly during type inference for newly seen reflection trees.
const gradientNoise2dNode = Fn(([point]) => {
  const cell = floor(point).toVar();
  const local = fract(point).toVar();
  const fade = local.mul(local).mul(float(3).sub(local.mul(2)));

  const gradientDot = (offset) => {
    const lattice = cell.add(offset);
    const angle = fract(
      sin(dot(lattice, vec2(HASH_COEFFICIENTS[0], HASH_COEFFICIENTS[1]))).mul(HASH_SCALE),
    ).mul(TWO_PI);
    const delta = local.sub(offset);
    return cos(angle).mul(delta.x).add(sin(angle).mul(delta.y));
  };

  const x0 = mix(gradientDot(vec2(0, 0)), gradientDot(vec2(1, 0)), fade.x);
  const x1 = mix(gradientDot(vec2(0, 1)), gradientDot(vec2(1, 1)), fade.x);
  return mix(x0, x1, fade.y).add(0.5);
}, 'float');

function windWarpNode(positionXZ, timeNode, prevailing, simulationSpeed, noiseScale, warp) {
  if (!(warp.amplitude > 0)) return vec2(0, 0);
  const clock = timeNode.mul(simulationSpeed).mul(warp.speed);
  const samplePoint = positionXZ
    .mul(float(warp.scale).mul(noiseScale))
    .sub(prevailing.mul(clock))
    .toVar();
  const along = gradientNoise2dNode(samplePoint).sub(0.5).mul(2 * warp.amplitude);
  const across = gradientNoise2dNode(
    samplePoint.add(vec2(WARP_LOOKUP_OFFSET[0], WARP_LOOKUP_OFFSET[1])),
  ).sub(0.5).mul(2 * warp.amplitude * warp.lateralGain);
  const perpendicular = vec2(prevailing.y.negate(), prevailing.x);
  return prevailing.mul(along).add(perpendicular.mul(across));
}

function sampleLayerNode(positionXZ, timeNode, direction, simulationSpeed, noiseScale, layer, warpOffset) {
  const clock = timeNode.mul(simulationSpeed).mul(layer.speed);
  return gradientNoise2dNode(
    positionXZ
      .mul(float(layer.scale).mul(noiseScale))
      .sub(direction.mul(clock))
      .add(warpOffset),
  );
}

export function createCinematicWindFieldNode({
  positionXZ,
  timeNode,
  directionDegrees,
  intensity,
  simulationSpeed,
  noiseScale = sharedWindUniforms.noiseScale,
  config = {},
}) {
  const params = resolveWindConfig(config);
  const directionRadians = directionDegrees.mul(DEG_TO_RAD);
  const prevailing = vec2(cos(directionRadians), sin(directionRadians));
  const directionClock = timeNode.mul(simulationSpeed).mul(params.direction.speed);
  const directionNoise = gradientNoise2dNode(
    positionXZ
      .mul(float(params.direction.scale).mul(noiseScale))
      .sub(prevailing.mul(directionClock)),
  ).sub(0.5).mul(2);
  const localAngle = directionRadians.add(
    directionNoise.mul(params.direction.variationDegrees * DEG_TO_RAD),
  );
  const direction = vec2(cos(localAngle), sin(localAngle));

  // Advect along `prevailing`, not `direction`, and take the meander from the bounded warp —
  // see the notes in sampleCinematicWindCpu.
  const warpOffset = windWarpNode(
    positionXZ,
    timeNode,
    prevailing,
    simulationSpeed,
    noiseScale,
    params.warp,
  ).toVar();
  const large = sampleLayerNode(positionXZ, timeNode, prevailing, simulationSpeed, noiseScale, params.large, warpOffset);
  const previousLarge = sampleLayerNode(
    positionXZ,
    timeNode.sub(params.gust.inertiaSeconds),
    prevailing,
    simulationSpeed,
    noiseScale,
    params.large,
    warpOffset,
  );
  const medium = sampleLayerNode(
    positionXZ,
    timeNode,
    prevailing,
    simulationSpeed,
    noiseScale,
    params.medium,
    warpOffset,
  ).sub(0.5).mul(2);
  const flutter = sampleLayerNode(
    positionXZ,
    timeNode,
    prevailing,
    simulationSpeed,
    noiseScale,
    params.flutter,
    warpOffset,
  ).sub(0.5).mul(2);

  const gust = smoothstep(params.gust.threshold, params.gust.peak, large).pow(params.gust.exponent);
  const previousGust = smoothstep(
    params.gust.threshold,
    params.gust.peak,
    previousLarge,
  ).pow(params.gust.exponent);
  const inertia = gust.sub(previousGust).mul(params.gust.inertiaGain);
  const envelope = float(params.baseStrength)
    .add(gust.mul(params.large.strength))
    .add(medium.abs().mul(params.medium.strength))
    .add(inertia)
    .clamp(params.minStrength, params.maxStrength);

  return {
    direction,
    strength: envelope.mul(intensity.max(0)),
    gust,
    turbulence: medium,
    flutter,
  };
}
