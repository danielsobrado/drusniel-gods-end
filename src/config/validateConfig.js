// Fails fast on a merged configuration that is missing a key the runtime
// dereferences without a guard, so a bad edit surfaces as a named error rather
// than a TypeError from deep inside a constructor.
//
// Scope is deliberately narrow: only keys read WITHOUT optional chaining or a
// `??` fallback. Optional assets (assets.grassAtlas, assets.grassMask, zones)
// are designed to fall back with a warning, and validating them would turn
// documented "continue with warnings" behavior into a hard startup failure.

const REQUIRED_OBJECTS = [
  ['camera', 'camera'],
  ['player', 'player'],
  ['terrain', 'terrain'],
  ['painter', 'GrassPainter, GrassMask, GrassMaterial'],
  ['grass', 'GrassField'],
  ['grass.interaction', 'InteractionMap, PlayerController, DemoUi'],
  ['assets', 'asset loading'],
  ['assets.audio', 'AudioSystem'],
  ['assets.leaves', 'LeafSystem'],
  ['quality', 'GrassField, EnvironmentController'],
  ['presets', 'EnvironmentController'],
  ['ui', 'DemoUi'],
  ['renderer', 'createWorld'],
  ['world', 'createWorld'],
  ['sun', 'createWorld'],
  ['hemisphere', 'createWorld'],
  ['ambient', 'createWorld'],
];

function resolve(config, path) {
  let current = config;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function validateConfig(config) {
  const problems = [];

  if (!config || typeof config !== 'object') {
    throw new Error('Merged configuration is not an object.');
  }

  for (const [path, consumer] of REQUIRED_OBJECTS) {
    const value = resolve(config, path);
    if (value === null || typeof value !== 'object') {
      problems.push(`missing or non-object: ${path} (required by ${consumer})`);
    }
  }

  // The initial selections must actually name an existing profile/preset.
  const initialQuality = config.ui?.initialQuality;
  if (initialQuality !== undefined && !config.quality?.[initialQuality]) {
    problems.push(`ui.initialQuality is "${initialQuality}", which is not a key of quality`);
  }

  const initialPreset = config.ui?.initialPreset;
  if (initialPreset !== undefined && !config.presets?.[initialPreset]) {
    problems.push(`ui.initialPreset is "${initialPreset}", which is not a key of presets`);
  }

  // EnvironmentController reads fogMultiplier for whichever quality is active.
  for (const [name, profile] of Object.entries(config.quality ?? {})) {
    if (typeof profile?.fogMultiplier !== 'number') {
      problems.push(`quality.${name}.fogMultiplier is missing or not a number`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Merged configuration is invalid:\n  - ${problems.join('\n  - ')}\n`
      + 'Run `npm run config:dump` to inspect the merged result.',
    );
  }

  return config;
}
