const UINT32_MAX = 4294967295;

function finiteNumber(value, name, {
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  exclusiveMin = false,
} = {}) {
  const number = Number(value);
  const belowMin = exclusiveMin ? !(number > min) : number < min;
  if (!Number.isFinite(number) || belowMin || number > max) {
    throw new Error(`${name} must be a finite number in the configured range.`);
  }
  return number;
}

function integer(value, name, options) {
  const number = finiteNumber(value, name, options);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer.`);
  return number;
}

function orderedRange(config, minKey, maxKey, prefix, options) {
  const min = finiteNumber(config[minKey], `${prefix}.${minKey}`, options);
  const max = finiteNumber(config[maxKey], `${prefix}.${maxKey}`, options);
  if (max < min) throw new Error(`${prefix}.${maxKey} must be greater than or equal to ${prefix}.${minKey}.`);
  return { min, max };
}

export function resolveSnowPowderConfig(config) {
  if (!config) throw new Error('ground.snow.powder configuration is required.');
  const prefix = 'ground.snow.powder';
  if (typeof config.color !== 'string' || config.color.length === 0) {
    throw new Error(`${prefix}.color must be a color string.`);
  }
  return {
    enabled: config.enabled !== false,
    capacity: integer(config.capacity, `${prefix}.capacity`, { min: 1, max: 1024 }),
    particlesPerContact: integer(config.particlesPerContact, `${prefix}.particlesPerContact`, { min: 1, max: 64 }),
    runningMultiplier: finiteNumber(config.runningMultiplier, `${prefix}.runningMultiplier`, { min: 0, exclusiveMin: true }),
    emitDistance: finiteNumber(config.emitDistance, `${prefix}.emitDistance`, { min: 0, exclusiveMin: true }),
    minCoverage: finiteNumber(config.minCoverage, `${prefix}.minCoverage`, { min: 0, max: 1 }),
    contactHeight: finiteNumber(config.contactHeight, `${prefix}.contactHeight`, { min: 0, exclusiveMin: true }),
    normalSampleDistance: finiteNumber(config.normalSampleDistance, `${prefix}.normalSampleDistance`, { min: 0, exclusiveMin: true }),
    spawnHeight: finiteNumber(config.spawnHeight, `${prefix}.spawnHeight`, { min: 0 }),
    spread: finiteNumber(config.spread, `${prefix}.spread`, { min: 0 }),
    lifetime: orderedRange(config, 'lifetimeMin', 'lifetimeMax', prefix, { min: 0, exclusiveMin: true }),
    size: orderedRange(config, 'sizeMin', 'sizeMax', prefix, { min: 0, exclusiveMin: true }),
    sizeGrowth: finiteNumber(config.sizeGrowth, `${prefix}.sizeGrowth`, { min: 0 }),
    fadeStart: finiteNumber(config.fadeStart, `${prefix}.fadeStart`, { min: 0, max: 1 }),
    horizontalSpeed: orderedRange(config, 'horizontalSpeedMin', 'horizontalSpeedMax', prefix, { min: 0 }),
    verticalSpeed: orderedRange(config, 'verticalSpeedMin', 'verticalSpeedMax', prefix, { min: 0 }),
    drag: finiteNumber(config.drag, `${prefix}.drag`, { min: 0 }),
    gravity: finiteNumber(config.gravity, `${prefix}.gravity`, { min: 0 }),
    opacity: finiteNumber(config.opacity, `${prefix}.opacity`, { min: 0, max: 1 }),
    color: config.color,
    textureSize: integer(config.textureSize, `${prefix}.textureSize`, { min: 16, max: 256 }),
    seed: integer(config.seed, `${prefix}.seed`, { min: 0, max: UINT32_MAX }) >>> 0,
  };
}
