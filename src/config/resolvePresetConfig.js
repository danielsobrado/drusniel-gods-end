function merge(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(base?.[key] ?? {}, value) : value;
  }
  return result;
}

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

export function isReferencePreset(config, name) {
  const source = config?.presets?.[name];
  return Boolean(source?.biomeProfile && config?.biomes?.[source.biomeProfile]);
}

export function setReferenceBiomeEnabled(config, enabled) {
  if (!config.biomes) config.biomes = {};
  if (!config.biomes.referenceScrub) config.biomes.referenceScrub = { seed: 28411 };
  config.biomes.referenceScrub.enabled = Boolean(enabled);
  return config;
}

/** Resolve an opt-in look without modifying the original preset or shared style. */
export function resolvePresetConfig(config, name) {
  const source = config.presets?.[name];
  if (!source) return undefined;
  const profile = config.biomes?.[source.biomeProfile];
  const active = profile?.enabled === true;
  const resolved = merge(clone(source), active ? clone(source.referenceLook) : null);
  resolved.style = merge(clone(config.cinematic?.style) ?? {}, active ? clone(source.referenceLook?.style) : null);
  resolved.activeBiome = active ? source.biomeProfile : null;
  resolved.biome = active ? clone(profile) : null;
  return resolved;
}
