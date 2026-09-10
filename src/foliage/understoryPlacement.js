import { resolvePresetConfig } from '../config/resolvePresetConfig.js';
import { resolvePopulationCap } from './populationCap.js';
import { createSeededRandom } from '../core/math.js';

export const DEFAULT_UNDERSTORY = Object.freeze({
  enabled: true,
  radius: 62,
  cellSize: 12,
  candidatesPerCell: 7,
  count: 800,
  minDensity: 0.08,
  minUnderstory: 0.18,
  pathThreshold: 0.3,
  minScale: 0.88,
  maxScale: 1.16,
  stretch: 0.05,
  embed: 0.02,
  alphaTest: 0.1,
  shadowAlphaTest: 0.35,
  windBend: 0.08,
  windFlutter: 0.018,
  fadeWidth: 14,
  billboardStart: 22,
  billboardEnd: 30,
  worldScale: 36,
  density: 1,
  moistureBias: 0,
  understoryBias: 0,
  seed: 41753,
  quality: Object.freeze({
    performance: Object.freeze({ density: 0.3, radius: 0.46, shadows: false, billboard: 0.55 }),
    balanced: Object.freeze({ density: 0.52, radius: 0.68, shadows: false, billboard: 0.75 }),
    high: Object.freeze({ density: 0.84, radius: 0.9, shadows: true, billboard: 1 }),
    ultra: Object.freeze({ density: 1, radius: 1, shadows: true, billboard: 1.25 }),
  }),
});

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function mergeQuality(base, override) {
  const merged = { ...base, ...(override ?? {}) };
  for (const name of Object.keys(base)) {
    merged[name] = { ...base[name], ...(override?.[name] ?? {}) };
  }
  return merged;
}

export function resolveUnderstorySettings(config = {}, presetName, qualityName) {
  const configured = config.foliage?.understory;
  const base = {
    ...DEFAULT_UNDERSTORY,
    ...(configured ?? {}),
    quality: mergeQuality(DEFAULT_UNDERSTORY.quality, configured?.quality),
  };
  if (base.seed == null) base.seed = (config.vegetation?.seed ?? 0) + DEFAULT_UNDERSTORY.seed;
  const preset = resolvePresetConfig(config, presetName)?.foliage?.understory ?? {};
  const quality = base.quality[qualityName] ?? DEFAULT_UNDERSTORY.quality.high;
  const enabled = preset.enabled ?? base.enabled;
  if (enabled === false) {
    return {
      ...base,
      ...preset,
      enabled: false,
      density: 0,
      radius: 0,
      candidatesPerCell: 0,
      castShadow: false,
    };
  }

  const densityScale = quality.density ?? 1;
  return {
    ...base,
    ...preset,
    enabled: true,
    density: Math.max(0, (preset.density ?? base.density) * densityScale),
    radius: Math.max(0, (preset.radius ?? base.radius) * (quality.radius ?? 1)),
    candidatesPerCell: Math.max(
      0,
      Math.round((preset.candidatesPerCell ?? base.candidatesPerCell) * densityScale),
    ),
    windBend: preset.windBend ?? base.windBend,
    moistureBias: preset.moistureBias ?? base.moistureBias,
    understoryBias: preset.understoryBias ?? base.understoryBias,
    castShadow: preset.castShadow ?? (quality.shadows === true),
    maxInstancesTotal: resolvePopulationCap(preset.maxInstancesTotal ?? base.maxInstancesTotal, qualityName),
    billboardStart: Math.max(0, (preset.billboardStart ?? base.billboardStart) * (quality.billboard ?? 1)),
    billboardEnd: Math.max(1, (preset.billboardEnd ?? base.billboardEnd) * (quality.billboard ?? 1),
      (preset.billboardStart ?? base.billboardStart) * (quality.billboard ?? 1) + 1),
  };
}

export function understoryPlacementChance(ecology, settings) {
  if (!settings?.enabled) return 0;
  if (!ecology) return 0;
  if (ecology.path >= (settings.pathThreshold ?? DEFAULT_UNDERSTORY.pathThreshold)) return 0;
  if (ecology.understory < (settings.minUnderstory ?? DEFAULT_UNDERSTORY.minUnderstory)) return 0;
  if (ecology.density < (settings.minDensity ?? DEFAULT_UNDERSTORY.minDensity)) return 0;
  const shade = clamp01(Number(ecology.understory) + (settings.understoryBias ?? 0));
  const moisture = clamp01(Number(ecology.moisture) + (settings.moistureBias ?? 0));
  return clamp01(
    shade
      * (0.5 + 0.5 * moisture)
      * (0.65 + 0.35 * Number(ecology.density))
      * (settings.density ?? 1),
  );
}

export function createUnderstoryCellRandom(cellX, cellZ, seed) {
  return createSeededRandom(Math.imul(cellX, 19349663) ^ Math.imul(cellZ, 83492791) ^ (seed | 0));
}

export function* iterateUnderstoryPlants({
  origin,
  settings,
  variantCount,
  sampleEcology,
  contains,
  sampleHeight,
  waterY = Number.NEGATIVE_INFINITY,
  cache,
} = {}) {
  if (!settings?.enabled || !(settings.radius > 0) || !(variantCount > 0) || !origin) return;

  const cellSize = settings.cellSize ?? DEFAULT_UNDERSTORY.cellSize;
  const candidates = settings.candidatesPerCell ?? 0;
  const cx = Math.floor(origin.x / cellSize);
  const cz = Math.floor(origin.z / cellSize);
  const extent = Math.ceil(settings.radius / cellSize);
  const seed = settings.seed ?? DEFAULT_UNDERSTORY.seed;
  const stretchAmount = settings.stretch ?? 0;
  const embed = settings.embed ?? 0;
  const minScale = settings.minScale ?? DEFAULT_UNDERSTORY.minScale;
  const maxScale = settings.maxScale ?? DEFAULT_UNDERSTORY.maxScale;
  cache?.setWindow(cx, cz, extent, cellSize);

  for (let x = cx - extent; x <= cx + extent; x += 1) {
    for (let z = cz - extent; z <= cz + extent; z += 1) {
      const random = createUnderstoryCellRandom(x, z, seed);
      for (let i = 0; i < candidates; i += 1) {
        const px = (x + random()) * cellSize;
        const pz = (z + random()) * cellSize;
        if (((x + z + i) & 15) === 0) yield undefined;
        if (Math.hypot(px - origin.x, pz - origin.z) > settings.radius) continue;
        const sampled = cache
          ? cache.getOrCompute(px, pz, (x, z) => ({
            contains: contains ? contains(x, z) : true,
            height: sampleHeight?.(x, z),
            ecology: sampleEcology?.(x, z),
          }))
          : {
            contains: contains ? contains(px, pz) : true,
            height: sampleHeight?.(px, pz),
            ecology: sampleEcology?.(px, pz),
          };
        if (!sampled.contains) continue;
        const py = sampled.height;
        if (!Number.isFinite(py) || py < waterY) continue;
        if (random() > understoryPlacementChance(sampled.ecology, settings)) continue;
        const scale = minScale + random() * (maxScale - minScale);
        const stretch = 1 + (random() * 2 - 1) * stretchAmount;
        yield {
          x: px,
          y: py - embed,
          z: pz,
          yaw: random() * Math.PI * 2,
          scaleX: scale * stretch,
          scaleY: scale,
          scaleZ: scale / Math.max(stretch, 0.001),
          variant: Math.floor(random() * variantCount),
        };
      }
    }
  }
}

export function placeUnderstoryPlants(options) {
  return [...iterateUnderstoryPlants(options)].filter(Boolean);
}
