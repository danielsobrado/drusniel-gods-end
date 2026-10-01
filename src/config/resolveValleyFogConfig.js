const PREFIX = 'ground.snow.atmosphere.valleyFog';

function finite(value, name, { min = -Infinity, max = Infinity, exclusiveMin = false } = {}) {
  const number = Number(value);
  const low = exclusiveMin ? !(number > min) : number < min;
  if (!Number.isFinite(number) || low || number > max) {
    throw new Error(`${PREFIX}.${name} must be a finite number in range.`);
  }
  return number;
}

function colorString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${PREFIX}.${name} must be a color string.`);
  return value;
}

// Valley mist over snow country (see src/rendering/valleyFog.js). Returns null
// when the snow, its atmosphere or the valley fog is switched off.
export function resolveValleyFogConfig(config) {
  const snow = config?.ground?.snow;
  const settings = snow?.enabled && snow.atmosphere?.enabled !== false ? snow.atmosphere?.valleyFog : null;
  if (!settings || settings.enabled === false) return null;
  const nearStart = finite(settings.nearClear?.[0], 'nearClear[0]', { min: 0 });
  const nearEnd = finite(settings.nearClear?.[1], 'nearClear[1]', { min: 0 });
  if (!(nearEnd > nearStart)) throw new Error(`${PREFIX}.nearClear must rise from its first value to its second.`);
  return {
    density: finite(settings.density, 'density', { min: 0 }),
    height: finite(settings.height, 'height', { min: 0, exclusiveMin: true }),
    ceiling: finite(settings.ceiling, 'ceiling', { min: 0, exclusiveMin: true }),
    pocketScale: finite(settings.pocketScale, 'pocketScale', { min: 0, exclusiveMin: true }),
    pocketStrength: finite(settings.pocketStrength, 'pocketStrength', { min: 0, max: 1 }),
    drift: finite(settings.drift, 'drift', { min: 0 }),
    nearStart,
    nearEnd,
    maxDistance: finite(settings.maxDistance, 'maxDistance', { min: 0, exclusiveMin: true }),
    samples: Math.round(finite(settings.samples, 'samples', { min: 1, max: 16 })),
    scatter: finite(settings.scatter, 'scatter', { min: 0, max: 0.95 }),
    sunScatter: finite(settings.sunScatter, 'sunScatter', { min: 0 }),
    shadeColor: colorString(settings.shadeColor, 'shadeColor'),
    windAngleDegrees: finite(snow.wind?.angleDegrees, 'wind.angleDegrees'),
  };
}
