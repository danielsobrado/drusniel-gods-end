// Player-selectable post effects. `cinematic.post.effects` seeds the defaults;
// grain and vignette keep their strengths in `cinematic.post` and only switch.
export const POST_EFFECT_TOGGLES = Object.freeze([
  { key: 'taa', label: 'Temporal AA' },
  { key: 'bloom', label: 'Bloom' },
  { key: 'lightShafts', label: 'Light Shafts' },
  { key: 'depthOfField', label: 'Depth of Field' },
  { key: 'sharpen', label: 'Sharpen' },
  { key: 'grain', label: 'Film Grain' },
  { key: 'vignette', label: 'Vignette' },
]);

// Continuous depth-of-field levels. Both feed uniforms the pipeline already
// holds, so the HUD can move them live without rebuilding the effect graph.
// `focusDistance` stays out: it tracks the character every frame, and a manual
// override would just let the player defocus themselves.
export const POST_EFFECT_LEVELS = Object.freeze([
  { key: 'focalRange', label: 'Focus Range', min: 10, max: 60, step: 1, fallback: 34 },
  { key: 'bokehScale', label: 'Blur Strength', min: 0.2, max: 1.6, step: 0.05, fallback: 0.7 },
]);

export const TONEMAPPERS = Object.freeze([
  { value: 'aces', label: 'ACES' },
  { value: 'agx', label: 'AgX' },
]);

const DEFAULT_EFFECTS = Object.freeze({
  taa: false,
  bloom: true,
  lightShafts: false,
  depthOfField: true,
  sharpen: false,
  grain: true,
  vignette: true,
  tonemapper: 'aces',
});

export function resolvePostEffects(post) {
  const effects = { ...DEFAULT_EFFECTS };
  for (const [key, fallback] of Object.entries(DEFAULT_EFFECTS)) {
    const value = post?.effects?.[key];
    if (typeof value === typeof fallback) effects[key] = value;
  }
  if (!TONEMAPPERS.some(({ value }) => value === effects.tonemapper)) effects.tonemapper = DEFAULT_EFFECTS.tonemapper;
  return effects;
}

export function isPostEffect(name, value) {
  if (name === 'tonemapper') return TONEMAPPERS.some((option) => option.value === value);
  return POST_EFFECT_TOGGLES.some(({ key }) => key === name) && typeof value === 'boolean';
}

// Depth-of-field levels come from `cinematic.post.depthOfField`; anything
// missing or out of range falls back to the shipped subtle look.
export function resolvePostLevels(post) {
  const levels = {};
  for (const { key, min, max, fallback } of POST_EFFECT_LEVELS) {
    const value = Number(post?.depthOfField?.[key]);
    levels[key] = Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
  }
  return levels;
}

export function isPostLevel(name, value) {
  const level = POST_EFFECT_LEVELS.find(({ key }) => key === name);
  return Boolean(level) && Number.isFinite(value) && value >= level.min && value <= level.max;
}
