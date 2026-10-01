export const DEFAULT_VEGETATION_CUTOFF = 0.3;
export const DEFAULT_VEGETATION_SOFTNESS = 0.12;
export const DEFAULT_PATH_CLEARANCE = 0.5;

function smoothstep(edge0, edge1, value) {
  if (edge1 <= edge0) return value <= edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function vegetationStrength(raw, cutoff = DEFAULT_VEGETATION_CUTOFF, softness = DEFAULT_VEGETATION_SOFTNESS) {
  if (!(raw > 0)) return 0;
  return raw * smoothstep(cutoff, cutoff + softness, raw);
}

export function allowsVegetation(strength) {
  return strength > 0;
}

export function resolveVegetationPolicy(config) {
  const vegetation = config?.vegetation ?? {};
  const grass = config?.grass ?? {};
  return {
    cutoff: vegetation.shaderCutoff ?? grass.vegetationCutoff ?? DEFAULT_VEGETATION_CUTOFF,
    softness: vegetation.shaderSoftness ?? grass.maskSoftness ?? DEFAULT_VEGETATION_SOFTNESS,
    clearance: vegetation.path?.clearance ?? grass.pathClearance ?? DEFAULT_PATH_CLEARANCE,
  };
}
