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

// Flake populations sharing the one instanced field: each takes `share` of the
// count and its own column width, sizes, opacity, fall speed, near fade,
// softness (0 a crisp flake, 1 an out-of-focus disc) and brightness. Without
// `layers` the field is a single population from the top-level values.
function resolveLayers(config, prefix, base, count) {
  const source = Array.isArray(config.layers) && config.layers.length > 0 ? config.layers : [{ share: 1 }];
  const layers = source.map((layer, index) => {
    const path = `${prefix}.layers[${index}]`;
    const sizeMin = finiteNumber(layer.sizeMin ?? base.sizeMin, `${path}.sizeMin`, { min: 0, exclusiveMin: true });
    const sizeMax = finiteNumber(layer.sizeMax ?? base.sizeMax, `${path}.sizeMax`, { min: 0, exclusiveMin: true });
    if (sizeMax < sizeMin) throw new Error(`${path}.sizeMax must be greater than or equal to ${path}.sizeMin.`);
    return {
      share: finiteNumber(layer.share, `${path}.share`, { min: 0, exclusiveMin: true }),
      area: finiteNumber(layer.area ?? base.area, `${path}.area`, { min: 0, exclusiveMin: true }),
      sizeMin,
      sizeMax,
      opacity: finiteNumber(layer.opacity ?? base.opacity, `${path}.opacity`, { min: 0, max: 1 }),
      speedScale: finiteNumber(layer.speedScale ?? 1, `${path}.speedScale`, { min: 0, exclusiveMin: true }),
      nearFade: finiteNumber(layer.nearFade ?? base.nearFade, `${path}.nearFade`, { min: 0 }),
      softness: finiteNumber(layer.softness ?? 0, `${path}.softness`, { min: 0, max: 1 }),
      brightness: finiteNumber(layer.brightness ?? 1, `${path}.brightness`, { min: 0, max: 2 }),
    };
  });
  // Contiguous instance ranges, the last absorbing rounding.
  const total = layers.reduce((sum, layer) => sum + layer.share, 0);
  let start = 0;
  layers.forEach((layer, index) => {
    const end = index === layers.length - 1 ? count : Math.min(count, start + Math.round(count * layer.share / total));
    layer.start = start;
    layer.end = end;
    start = end;
  });
  return layers;
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

  const count = integer(config.count, `${prefix}.count`, { min: 1, max: 20000 });
  const area = finiteNumber(config.area, `${prefix}.area`, { min: 0, exclusiveMin: true });
  const opacity = finiteNumber(config.opacity, `${prefix}.opacity`, { min: 0, max: 1 });
  const nearFade = finiteNumber(config.nearFade, `${prefix}.nearFade`, { min: 0 });
  const gust = config.gust ?? {};
  return {
    enabled: true,
    count,
    area,
    top,
    bottom,
    speed: finiteNumber(config.speed, `${prefix}.speed`, { min: 0, exclusiveMin: true }),
    sizeMin,
    sizeMax,
    swayRadius: finiteNumber(config.swayRadius, `${prefix}.swayRadius`, { min: 0 }),
    swayFrequency: finiteNumber(config.swayFrequency, `${prefix}.swayFrequency`, { min: 0 }),
    windSpeed: finiteNumber(config.windSpeed, `${prefix}.windSpeed`, { min: 0 }),
    opacity,
    color: config.color,
    layers: resolveLayers(config, prefix, { sizeMin, sizeMax, area, opacity, nearFade }, count),
    // Gusts scale the shared wind; turbulence swirls each flake across it.
    gust: {
      strength: finiteNumber(gust.strength ?? 0, `${prefix}.gust.strength`, { min: 0, max: 0.95 }),
      period: finiteNumber(gust.period ?? 9, `${prefix}.gust.period`, { min: 0, exclusiveMin: true }),
    },
    turbulence: finiteNumber(config.turbulence ?? 0, `${prefix}.turbulence`, { min: 0 }),
    minCoverage,
    fullCoverage,
    maxIntensity: finiteNumber(config.maxIntensity, `${prefix}.maxIntensity`, { min: 0, max: 1 }),
    fadeRate: finiteNumber(config.fadeRate, `${prefix}.fadeRate`, { min: 0, exclusiveMin: true }),
    nearFade,
    sampleDistance: finiteNumber(config.sampleDistance, `${prefix}.sampleDistance`, { min: 0, exclusiveMin: true }),
  };
}
