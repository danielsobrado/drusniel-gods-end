import { resolvePresetConfig } from '../config/resolvePresetConfig.js';
import { resolvePopulationCap } from './populationCap.js';
import { createSeededRandom } from '../core/math.js';

export const DEFAULT_WILD_GRASS = Object.freeze({
  enabled: true,
  radius: 68,
  cellSize: 12,
  candidatesPerCell: 11,
  count: 1800,
  minDensity: 0.12,
  minGrowth: 0.18,
  pathThreshold: 0.3,
  minScale: 0.82,
  maxScale: 1.22,
  stretch: 0.07,
  embed: 0.03,
  alphaTest: 0.32,
  shadowAlphaTest: 0.55,
  windBend: 0.11,
  windFlutter: 0.028,
  fadeWidth: 16,
  worldScale: 0.68,
  density: 1,
  moistureBias: 0,
  growthBias: 0,
  seed: 28411,
  quality: Object.freeze({
    performance: Object.freeze({ density: 0.32, radius: 0.48, shadows: false }),
    balanced: Object.freeze({ density: 0.55, radius: 0.7, shadows: false }),
    high: Object.freeze({ density: 0.85, radius: 0.9, shadows: true }),
    ultra: Object.freeze({ density: 1, radius: 1, shadows: true }),
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

export function resolveWildGrassSettings(config = {}, presetName, qualityName) {
  const configured = config.foliage?.wildGrass;
  const base = {
    ...DEFAULT_WILD_GRASS,
    ...(configured ?? {}),
    quality: mergeQuality(DEFAULT_WILD_GRASS.quality, configured?.quality),
  };
  if (base.seed == null) base.seed = config.vegetation?.seed ?? DEFAULT_WILD_GRASS.seed;
  const preset = resolvePresetConfig(config, presetName)?.foliage?.wildGrass ?? {};
  const quality = base.quality[qualityName] ?? DEFAULT_WILD_GRASS.quality.high;
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
    growthBias: preset.growthBias ?? base.growthBias,
    castShadow: preset.castShadow ?? (quality.shadows === true),
    maxInstancesTotal: resolvePopulationCap(preset.maxInstancesTotal ?? base.maxInstancesTotal, qualityName),
  };
}

export function wildGrassPlacementChance(ecology, settings) {
  if (!settings?.enabled) return 0;
  if (!ecology) return 0;
  if (ecology.path >= (settings.pathThreshold ?? DEFAULT_WILD_GRASS.pathThreshold)) return 0;
  if (ecology.density < (settings.minDensity ?? DEFAULT_WILD_GRASS.minDensity)) return 0;
  if (ecology.growth < (settings.minGrowth ?? DEFAULT_WILD_GRASS.minGrowth)) return 0;
  const moisture = clamp01(Number(ecology.moisture) + (settings.moistureBias ?? 0));
  const growth = clamp01(Number(ecology.growth) + (settings.growthBias ?? 0));
  return clamp01(
    (0.4 + 0.6 * Number(ecology.density))
      * (0.55 + 0.45 * growth)
      * (0.8 + 0.2 * moisture)
      * (settings.density ?? 1),
  );
}

export function wildGrassCellKey(x, z) {
  return `${x},${z}`;
}

export function createWildGrassCellRandom(cellX, cellZ, seed) {
  return createSeededRandom(Math.imul(cellX, 73856093) ^ Math.imul(cellZ, 19349663) ^ (seed | 0));
}

export function* iterateWildGrassClumps({
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

  const cellSize = settings.cellSize ?? DEFAULT_WILD_GRASS.cellSize;
  const candidates = settings.candidatesPerCell ?? 0;
  const cx = Math.floor(origin.x / cellSize);
  const cz = Math.floor(origin.z / cellSize);
  const extent = Math.ceil(settings.radius / cellSize);
  const seed = settings.seed ?? DEFAULT_WILD_GRASS.seed;
  const stretchAmount = settings.stretch ?? 0;
  const embed = settings.embed ?? 0;
  const minScale = settings.minScale ?? DEFAULT_WILD_GRASS.minScale;
  const maxScale = settings.maxScale ?? DEFAULT_WILD_GRASS.maxScale;
  cache?.setWindow(cx, cz, extent, cellSize);

  for (let x = cx - extent; x <= cx + extent; x += 1) {
    for (let z = cz - extent; z <= cz + extent; z += 1) {
      const random = createWildGrassCellRandom(x, z, seed);
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
        if (random() > wildGrassPlacementChance(sampled.ecology, settings)) continue;
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

export function placeWildGrassClumps(options) {
  return [...iterateWildGrassClumps(options)].filter(Boolean);
}
