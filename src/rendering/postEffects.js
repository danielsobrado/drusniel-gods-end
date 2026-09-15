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

export const TONEMAPPERS = Object.freeze([
  { value: 'aces', label: 'ACES' },
  { value: 'agx', label: 'AgX' },
]);

const DEFAULT_EFFECTS = Object.freeze({
  taa: false,
  bloom: true,
  lightShafts: false,
  depthOfField: false,
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
