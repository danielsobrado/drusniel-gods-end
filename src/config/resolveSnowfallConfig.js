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

export function resolveSnowfallConfig(config) {
  if (!config) throw new Error('ground.snow.snowfall configuration is required.');
  if (config.enabled === false) return { enabled: false };
  const prefix = 'ground.snow.snowfall';

  const bottom = finiteNumber(config.bottom, `${prefix}.bottom`);
  const top = finiteNumber(config.top, `${prefix}.top`);
  if (top <= bottom) throw new Error(`${prefix}.top must be greater than ${prefix}.bottom.`);
  const sizeMin = finiteNumber(config.sizeMin, `${prefix}.sizeMin`, { min: 0, exclusiveMin: true });
  const sizeMax = finiteNumber(config.sizeMax, `${prefix}.sizeMax`, { min: 0, exclusiveMin: true });
  if (sizeMax < sizeMin) throw new Error(`${prefix}.sizeMax must be greater than or equal to ${prefix}.sizeMin.`);
  const minCoverage = finiteNumber(config.minCoverage, `${prefix}.minCoverage`, { min: 0, max: 1 });
  const fullCoverage = finiteNumber(config.fullCoverage, `${prefix}.fullCoverage`, { min: 0, max: 1 });
  if (fullCoverage <= minCoverage) {
    throw new Error(`${prefix}.fullCoverage must be greater than ${prefix}.minCoverage.`);
  }
  if (typeof config.color !== 'string' || config.color.length === 0) {
    throw new Error(`${prefix}.color must be a color string.`);
  }

  return {
    enabled: true,
    count: integer(config.count, `${prefix}.count`, { min: 1, max: 20000 }),
    area: finiteNumber(config.area, `${prefix}.area`, { min: 0, exclusiveMin: true }),
    top,
    bottom,
    speed: finiteNumber(config.speed, `${prefix}.speed`, { min: 0, exclusiveMin: true }),
    sizeMin,
    sizeMax,
    swayRadius: finiteNumber(config.swayRadius, `${prefix}.swayRadius`, { min: 0 }),
    swayFrequency: finiteNumber(config.swayFrequency, `${prefix}.swayFrequency`, { min: 0 }),
    windSpeed: finiteNumber(config.windSpeed, `${prefix}.windSpeed`, { min: 0 }),
    opacity: finiteNumber(config.opacity, `${prefix}.opacity`, { min: 0, max: 1 }),
    color: config.color,
    minCoverage,
    fullCoverage,
    maxIntensity: finiteNumber(config.maxIntensity, `${prefix}.maxIntensity`, { min: 0, max: 1 }),
    fadeRate: finiteNumber(config.fadeRate, `${prefix}.fadeRate`, { min: 0, exclusiveMin: true }),
    nearFade: finiteNumber(config.nearFade, `${prefix}.nearFade`, { min: 0 }),
    sampleDistance: finiteNumber(config.sampleDistance, `${prefix}.sampleDistance`, { min: 0, exclusiveMin: true }),
  };
}
