// The world-scale contract (config `world.scale`): a human is `humanHeight`
// world units tall, which stands for `humanMetres` real metres. Assets authored
// in real metres scale by `unitsPerMetre`; characters size as ratios of a human.
export const WORLD_SCALE_DEFAULTS = Object.freeze({ humanHeight: 5, humanMetres: 1.8 });

export function resolveWorldScale(config) {
  const source = config?.world?.scale ?? {};
  const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  const humanHeight = positive(source.humanHeight, WORLD_SCALE_DEFAULTS.humanHeight);
  const humanMetres = positive(source.humanMetres, WORLD_SCALE_DEFAULTS.humanMetres);
  return { humanHeight, humanMetres, unitsPerMetre: humanHeight / humanMetres };
}

export function validateWorldScaleConfig(config, problems) {
  const scale = config?.world?.scale;
  if (scale === undefined) return;
  for (const key of ['humanHeight', 'humanMetres']) {
    const value = Number(scale[key]);
    if (!(value > 0) || !Number.isFinite(value)) problems.push(`world.scale.${key} must be a positive number`);
  }
}
