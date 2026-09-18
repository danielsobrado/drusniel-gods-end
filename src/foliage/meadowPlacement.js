import { createSeededRandom } from '../core/math.js';
import { coastX } from '../world/coast.js';

export const MEADOW_CELL_SIZE = 12;
// Snow coverage above which only stones lie on the ground: no leaf litter,
// flowers or reeds on snow.
export const MEADOW_SNOW_LIMIT = 0.3;

export const MEADOW_QUALITY_DENSITY = Object.freeze({
  performance: 3,
  balanced: 6,
  high: 10,
  ultra: 14,
});

function samplePoint(px, pz, {
  contains,
  sampleHeight,
  sampleEcology,
  sampleRiverEdge,
  sampleSnow,
  config,
}) {
  const sea = config.water?.sea;
  const py = sampleHeight?.(px, pz);
  return {
    contains: contains ? contains(px, pz) : true,
    height: py,
    coast: Boolean(sea?.enabled && px > coastX(pz, sea.shoreX) - 50),
    riverEdge: sampleRiverEdge?.(px, pz) ?? 100,
    snow: sampleSnow?.(px, pz) ?? 0,
    ecology: sampleEcology?.(px, pz) ?? { path: 0, moisture: 0, density: 1, understory: 0, growth: 1 },
  };
}

export function* iterateMeadowDetails({
  origin,
  radius,
  quality,
  config,
  stoneCount = 1,
  stoneHasColor,
  cache,
  contains,
  sampleHeight,
  sampleEcology,
  sampleRiverEdge,
  sampleSnow,
} = {}) {
  if (!(radius > 0) || !origin || !config?.vegetation?.details) return;

  const density = MEADOW_QUALITY_DENSITY[quality] ?? MEADOW_QUALITY_DENSITY.high;
  const ecologyConfig = config.vegetation.details;
  const waterY = (config.water?.position?.[1] ?? 0) - 0.1;
  const patchScale = config.cinematic?.vegetation?.patchScale ?? 0.035;
  const cx = Math.floor(origin.x / MEADOW_CELL_SIZE);
  const cz = Math.floor(origin.z / MEADOW_CELL_SIZE);
  const extent = Math.ceil(radius / MEADOW_CELL_SIZE);
  cache?.setWindow(cx, cz, extent, MEADOW_CELL_SIZE);

  for (let x = cx - extent; x <= cx + extent; x += 1) {
    for (let z = cz - extent; z <= cz + extent; z += 1) {
      const random = createSeededRandom(Math.imul(x, 73856093) ^ Math.imul(z, 19349663));
      for (let i = 0; i < density; i += 1) {
        const px = (x + random()) * MEADOW_CELL_SIZE;
        const pz = (z + random()) * MEADOW_CELL_SIZE;
        if (((x + z + i) & 15) === 0) yield undefined;
        if (Math.hypot(px - origin.x, pz - origin.z) > radius) continue;
        const sampled = cache
          ? cache.getOrCompute(px, pz, (x, z) => samplePoint(x, z, {
            contains, sampleHeight, sampleEcology, sampleRiverEdge, sampleSnow, config,
          }))
          : samplePoint(px, pz, { contains, sampleHeight, sampleEcology, sampleRiverEdge, sampleSnow, config });
        if (!sampled.contains) continue;
        const py = sampled.height;
        if (sampled.coast) continue;
        if (!Number.isFinite(py) || py < waterY) continue;
        if (sampled.riverEdge < 0.8) continue;
        const ecology = sampled.ecology;
        const patch = Math.sin(px * patchScale + Math.sin(pz * patchScale * 0.62)) * Math.sin(pz * patchScale);
        let type;
        if (ecology.path >= ecologyConfig.pathThreshold) {
          if (random() > ecologyConfig.pathDecorationChance) continue;
          type = random() > ecologyConfig.pathStoneChance ? 'litter' : 'stone';
        } else if (ecology.moisture >= ecologyConfig.wetThreshold && ecology.density >= ecologyConfig.minimumPlantDensity) {
          type = 'reed';
        } else if (ecology.understory >= ecologyConfig.understoryThreshold) {
          type = random() < ecologyConfig.fernChance ? 'fern' : 'litter';
        } else {
          if (ecology.density < ecologyConfig.minimumPlantDensity || patch < ecologyConfig.meadowPatchThreshold) continue;
          type = random() < ecologyConfig.flowerChance ? 'flower' : 'seed';
        }
        if (sampled.snow >= MEADOW_SNOW_LIMIT && type !== 'stone') continue;
        const stoneIndex = type === 'stone' ? Math.floor(random() * Math.max(1, stoneCount)) : 0;
        const yaw = random() * Math.PI * 2;
        const baseScale = ecologyConfig.minScale + random() * (ecologyConfig.maxScale - ecologyConfig.minScale);
        const ecologyScale = type === 'reed'
          ? ecologyConfig.reedBaseScale + ecology.moisture * ecologyConfig.reedMoistureScale
          : type === 'fern'
            ? ecologyConfig.fernBaseScale + ecology.understory * ecologyConfig.fernUnderstoryScale
            : ecologyConfig.plantBaseScale + ecology.growth * ecologyConfig.plantGrowthScale;
        const scale = type === 'stone' ? baseScale : baseScale * ecologyScale;
        const variation = Math.sin(px * 12.9898 + pz * 78.233) * 0.5 + 0.5;
        const humidityTint = ecology.moisture * ecologyConfig.humidityTint;
        const shadeTint = ecology.understory * ecologyConfig.shadeTint;
        const colored = type !== 'stone' || (stoneHasColor?.[stoneIndex] ?? true);
        let lightness = ecologyConfig.lightnessBase - shadeTint * ecologyConfig.lightnessShadeScale;
        if (colored) lightness += random() * ecologyConfig.lightnessVariation;
        yield {
          type,
          stoneIndex,
          x: px,
          y: type === 'stone' ? py : py - 0.015,
          originY: py,
          z: pz,
          yaw,
          scaleX: type === 'stone' ? scale : scale * (0.85 + variation * 0.3),
          scaleY: type === 'stone' ? scale : scale * (1.12 - variation * 0.24),
          scaleZ: type === 'stone' ? scale : scale,
          hue: ecologyConfig.hueBase + humidityTint - shadeTint,
          saturation: ecologyConfig.saturation,
          lightness,
        };
      }
    }
  }
}

export function placeMeadowDetails(options) {
  return [...iterateMeadowDetails(options)].filter(Boolean);
}
