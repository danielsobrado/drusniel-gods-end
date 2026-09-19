import { coastalJungleRegionWeight } from '../world/CoastalJungleRegion.js';
import { coastDistanceAt, sampleSandCoverageCpu } from '../world/CoastField.js';
import { forestWeight } from '../world/LandscapePaths.js';
import { lakeSignedDistance, resolveLakeShape } from '../world/LakeShape.js';
import { sampleSnowCoverageCpu, sampleSnowLandformCpu } from '../world/SnowDeformationField.js';

// Biome ids stored per map pixel; the minimap names the one under the player.
export const MAP_BIOMES = Object.freeze([
  { id: 'meadow', label: 'Meadow', color: [118, 150, 74] },
  { id: 'forest', label: 'Forest', color: [58, 96, 52] },
  { id: 'jungle', label: 'Coastal Jungle', color: [34, 112, 78] },
  { id: 'beach', label: 'Beach', color: [222, 202, 150] },
  { id: 'rock', label: 'Rocky Uplands', color: [138, 132, 120] },
  { id: 'snow', label: 'Snowfields', color: [236, 242, 248] },
  { id: 'lake', label: 'Lake', color: [62, 132, 168] },
  { id: 'river', label: 'River', color: [78, 150, 184] },
  { id: 'sea', label: 'Sea', color: [30, 92, 138] },
]);
const BIOME = Object.fromEntries(MAP_BIOMES.map((biome, index) => [biome.id, index]));

const SHALLOW_SEA = [70, 170, 176];
const DEEP_SEA = [18, 58, 102];
const LOWLAND = [132, 164, 80];
const FOOTHILL = [110, 128, 72];
const PATH = [206, 184, 138];
const TREE = [36, 70, 40];
const NORMAL_STEP = 3;
// Light from the north-west, as on printed relief maps.
const LIGHT = normalize([-0.55, 0.62, -0.55]);
const ROCK_SLOPE = 0.72;
const ROCK_ALTITUDE = 60;
const CONTOUR_INTERVAL = 20;
const JUNGLE_FADE = 60;

function normalize(v) {
  const length = Math.hypot(...v);
  return v.map(value => value / length);
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smoothstep(value, min, max) {
  const t = clamp01((value - min) / (max - min));
  return t * t * (3 - 2 * t);
}

function edgeNoise(x, z) {
  const a = Math.sin(x * 0.043 + Math.sin(z * 0.031) * 2.1);
  const b = Math.sin(z * 0.057 - Math.sin(x * 0.027) * 1.7);
  const c = Math.sin((x + z) * 0.11);
  return clamp01(0.5 + a * 0.22 + b * 0.22 + c * 0.08);
}

// Widens the jungle strip by half its fade on each side, so the ragged edge
// straddles the configured boundary instead of eating into the canopy.
function padJungleRegion(region) {
  const pad = JUNGLE_FADE / 2;
  return {
    zStart: Math.min(region.zStart, region.zEnd) - pad,
    zEnd: Math.max(region.zStart, region.zEnd) + pad,
    inlandStart: Math.min(region.inlandStart, region.inlandEnd) - pad,
    inlandEnd: Math.max(region.inlandStart, region.inlandEnd) + pad,
  };
}

// Maps the terrain sampler's rectangle onto a pixel grid `metersPerPixel` apart.
export function createMapFrame(bounds, metersPerPixel = 2.5) {
  const minX = bounds.min.x, minZ = bounds.min.z;
  const sizeX = bounds.max.x - minX, sizeZ = bounds.max.z - minZ;
  const width = Math.max(2, Math.round(sizeX / metersPerPixel));
  const height = Math.max(2, Math.round(sizeZ / metersPerPixel));
  return { minX, minZ, sizeX, sizeZ, width, height, metersPerPixel: sizeX / width };
}

// Colors one terrain column and names its biome. Water wins outright; on land,
// forest, jungle, rock, sand and snow layer over the meadow in that order.
function classify(x, z, context) {
  const { terrain, config, lake, sea, river, paths, jungleRegion } = context;
  const y = terrain.sampleHeight(x, z);
  const dx = terrain.sampleHeight(x - NORMAL_STEP, z) - terrain.sampleHeight(x + NORMAL_STEP, z);
  const dz = terrain.sampleHeight(x, z - NORMAL_STEP) - terrain.sampleHeight(x, z + NORMAL_STEP);
  const nLength = Math.hypot(dx, NORMAL_STEP * 2, dz) || 1;
  const nx = dx / nLength, ny = NORMAL_STEP * 2 / nLength, nz = dz / nLength;
  const light = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
  const shade = 0.62 + light * 0.5;

  if (sea?.enabled && y < sea.level && coastDistanceAt(x, z, sea) > -60) {
    const depth = clamp01((sea.level - y) / 60);
    return { biome: BIOME.sea, color: mix(SHALLOW_SEA, DEEP_SEA, Math.sqrt(depth)), shade: 1 };
  }
  const reach = river?.sample(x, z);
  if (reach && reach.edge < 0 && y <= reach.y + 0.2) {
    return { biome: BIOME.river, color: MAP_BIOMES[BIOME.river].color, shade: 1 };
  }
  if (lake && y < lake.level && x >= lake.bounds.minX && x <= lake.bounds.maxX
    && z >= lake.bounds.minZ && z <= lake.bounds.maxZ && lakeSignedDistance(x, z, lake) < lake.margin + lake.wobble) {
    const depth = clamp01((lake.level - y) / 10);
    return { biome: BIOME.lake, color: mix([96, 168, 186], MAP_BIOMES[BIOME.lake].color, depth), shade: 1 };
  }

  let biome = BIOME.meadow;
  let color = mix(LOWLAND, FOOTHILL, smoothstep(y, 0, 70));
  const forest = forestWeight(x, z) + (edgeNoise(x * 1.3 + 57, z * 1.3) - 0.5) * 0.2;
  if (forest > 0.35) {
    biome = BIOME.forest;
    color = mix(color, MAP_BIOMES[BIOME.forest].color, smoothstep(forest, 0.35, 0.7));
  }
  // The jungle strip is a rectangle in coast space; ragged edges read as canopy.
  const jungle = jungleRegion
    ? smoothstep(coastalJungleRegionWeight(x, z, jungleRegion, sea, JUNGLE_FADE) + (edgeNoise(x, z) - 0.5) * 0.8, 0.35, 0.6)
    : 0;
  if (jungle > 0) {
    color = mix(color, MAP_BIOMES[BIOME.jungle].color, jungle);
    if (jungle > 0.5) biome = BIOME.jungle;
  }
  const rock = Math.max(smoothstep(-ny, -ROCK_SLOPE, -ROCK_SLOPE + 0.12),
    smoothstep(y, ROCK_ALTITUDE, ROCK_ALTITUDE + 30) * 0.8);
  if (rock > 0) {
    color = mix(color, MAP_BIOMES[BIOME.rock].color, rock);
    if (rock > 0.5) biome = BIOME.rock;
  }
  const sand = sampleSandCoverageCpu(x, y, z, config).coverage;
  if (sand > 0) {
    color = mix(color, MAP_BIOMES[BIOME.beach].color, sand);
    if (sand > 0.5) biome = BIOME.beach;
  }
  const snow = sampleSnowCoverageCpu(x, y, z, ny, config, sampleSnowLandformCpu(terrain, x, z, config));
  if (snow > 0) {
    color = mix(color, MAP_BIOMES[BIOME.snow].color, snow);
    if (snow > 0.5) biome = BIOME.snow;
  }
  const path = paths?.sample(x, z) ?? 0;
  if (path > 0) color = mix(color, PATH, path * 0.85);
  // Faint contour lines every CONTOUR_INTERVAL metres of height.
  const band = Math.abs(((y / CONTOUR_INTERVAL) % 1 + 1) % 1 - 0.5) * 2;
  const contour = smoothstep(band, 0.9, 0.98) * 0.1;
  return { biome, color, shade: shade * (1 - contour) };
}

// Bakes the whole map a few rows at a time, so a caller can spread the work
// over frames. Each `next()` call bakes `rowsPerStep` rows; the final value is
// the finished map.
export function* bakeMinimap({ terrain, config, metersPerPixel = 2.5, rowsPerStep = 16 }) {
  const frame = createMapFrame(terrain.bounds, metersPerPixel);
  const { width, height } = frame;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const biome = new Uint8Array(width * height);
  const seaConfig = config.water?.sea;
  const context = {
    terrain,
    config,
    lake: resolveLakeShape(config),
    sea: seaConfig?.enabled ? seaConfig : null,
    river: terrain.river ?? null,
    paths: terrain.paths ?? null,
    jungleRegion: config.biomes?.coastalJungle?.enabled && seaConfig?.enabled
      ? padJungleRegion(config.biomes.coastalJungle.region) : null,
  };
  for (let row = 0; row < height; row += 1) {
    const z = frame.minZ + (row + 0.5) * frame.metersPerPixel;
    for (let column = 0; column < width; column += 1) {
      const x = frame.minX + (column + 0.5) * frame.metersPerPixel;
      const sample = classify(x, z, context);
      const index = row * width + column;
      biome[index] = sample.biome;
      rgba[index * 4] = sample.color[0] * sample.shade;
      rgba[index * 4 + 1] = sample.color[1] * sample.shade;
      rgba[index * 4 + 2] = sample.color[2] * sample.shade;
      rgba[index * 4 + 3] = 255;
    }
    if ((row + 1) % rowsPerStep === 0) yield (row + 1) / height;
  }
  return { ...frame, rgba, biome };
}

// Stamps tree canopies onto a finished map as soft dark dots.
export function stampTrees(map, positions, radiusMeters = 3.2) {
  const radius = Math.max(0.8, radiusMeters / map.metersPerPixel);
  const reach = Math.ceil(radius);
  for (const { x, z } of positions) {
    const cx = (x - map.minX) / map.metersPerPixel - 0.5;
    const cz = (z - map.minZ) / map.metersPerPixel - 0.5;
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;
    for (let row = Math.floor(cz) - reach; row <= Math.ceil(cz) + reach; row += 1) {
      if (row < 0 || row >= map.height) continue;
      for (let column = Math.floor(cx) - reach; column <= Math.ceil(cx) + reach; column += 1) {
        if (column < 0 || column >= map.width) continue;
        const cover = 1 - smoothstep(Math.hypot(column - cx, row - cz), radius * 0.55, radius);
        if (cover <= 0) continue;
        const offset = (row * map.width + column) * 4;
        const weight = cover * 0.55;
        map.rgba[offset] += (TREE[0] - map.rgba[offset]) * weight;
        map.rgba[offset + 1] += (TREE[1] - map.rgba[offset + 1]) * weight;
        map.rgba[offset + 2] += (TREE[2] - map.rgba[offset + 2]) * weight;
      }
    }
  }
}

export function biomeAt(map, x, z) {
  if (!map) return null;
  const column = Math.floor((x - map.minX) / map.metersPerPixel);
  const row = Math.floor((z - map.minZ) / map.metersPerPixel);
  if (column < 0 || row < 0 || column >= map.width || row >= map.height) return null;
  return MAP_BIOMES[map.biome[row * map.width + column]] ?? null;
}
