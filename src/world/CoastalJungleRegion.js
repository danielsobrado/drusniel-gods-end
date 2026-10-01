import { coastX, resolveCoastConfig } from './CoastField.js';

const MIN_SPAN = 0.001;
const RADIUS_SAMPLES = 32;

function smoothstep(value, min, max) {
  if (max <= min) return value >= max ? 1 : 0;
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return t * t * (3 - 2 * t);
}

function finiteRegion(region) {
  if (!region) return null;
  const zStart = Number(region.zStart);
  const zEnd = Number(region.zEnd);
  const inlandStart = Number(region.inlandStart);
  const inlandEnd = Number(region.inlandEnd);
  if (!Number.isFinite(zStart) || !Number.isFinite(zEnd)
    || !Number.isFinite(inlandStart) || !Number.isFinite(inlandEnd)) return null;
  if (Math.abs(zEnd - zStart) < MIN_SPAN || Math.abs(inlandEnd - inlandStart) < MIN_SPAN) return null;
  return {
    zMin: Math.min(zStart, zEnd),
    zMax: Math.max(zStart, zEnd),
    inlandMin: Math.min(inlandStart, inlandEnd),
    inlandMax: Math.max(inlandStart, inlandEnd),
  };
}

export function coastalJungleRegionCenter(region, sea) {
  const resolved = finiteRegion(region);
  if (!resolved || !sea) return null;
  const z = (resolved.zMin + resolved.zMax) * 0.5;
  const inland = (resolved.inlandMin + resolved.inlandMax) * 0.5;
  return { x: coastX(z, sea) - inland, z };
}

export function coastalJungleRegionRadius(region, sea) {
  const resolved = finiteRegion(region);
  const center = coastalJungleRegionCenter(region, sea);
  if (!resolved || !center) return 0;
  let radius = 0;
  for (let index = 0; index <= RADIUS_SAMPLES; index += 1) {
    const t = index / RADIUS_SAMPLES;
    const z = resolved.zMin + (resolved.zMax - resolved.zMin) * t;
    for (const inland of [resolved.inlandMin, resolved.inlandMax]) {
      radius = Math.max(radius, Math.hypot(coastX(z, sea) - inland - center.x, z - center.z));
    }
  }
  return radius;
}

export function coastalJungleRegionWeight(x, z, region, sea, edge = 18) {
  const resolved = finiteRegion(region);
  if (!resolved || !sea || !Number.isFinite(x) || !Number.isFinite(z)) return 0;
  // Most grass samples are outside this strip; avoid coastal trigonometry there.
  if (z < resolved.zMin || z > resolved.zMax) return 0;
  const inland = coastX(z, sea) - x;
  const fade = Math.max(0, Number(edge) || 0);
  const zFade = Math.min(fade, (resolved.zMax - resolved.zMin) * 0.5);
  const inlandFade = Math.min(fade, (resolved.inlandMax - resolved.inlandMin) * 0.5);
  const zWeight = zFade > 0
    ? smoothstep(z, resolved.zMin, resolved.zMin + zFade)
      * (1 - smoothstep(z, resolved.zMax - zFade, resolved.zMax))
    : Number(z >= resolved.zMin && z <= resolved.zMax);
  const inlandWeight = inlandFade > 0
    ? smoothstep(inland, resolved.inlandMin, resolved.inlandMin + inlandFade)
      * (1 - smoothstep(inland, resolved.inlandMax - inlandFade, resolved.inlandMax))
    : Number(inland >= resolved.inlandMin && inland <= resolved.inlandMax);
  return Math.max(0, Math.min(1, zWeight * inlandWeight));
}

// How much of the jungle the configured profile puts at a world position,
// fading over the ecology edge band; 0 when the biome is off.
export function coastalJungleProfileWeight(x, z, config) {
  const profile = config?.biomes?.coastalJungle;
  const sea = config?.water?.sea;
  if (!profile?.enabled || !sea?.enabled) return 0;
  return coastalJungleRegionWeight(x, z, profile.region, sea, profile.ecology?.edgeFade ?? 18);
}

/** True when a grass tile AABB can sample jungle vegetation scale. */
export function coastalJungleRegionOverlapsTile(x, z, tileSize, region, sea, edge = 18) {
  const resolved = finiteRegion(region);
  if (!resolved || !sea || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(tileSize)) return false;
  const half = Math.max(0, tileSize) * 0.5;
  if (z + half < resolved.zMin || z - half > resolved.zMax) return false;
  const fade = Math.max(0, Number(edge) || 0);
  const z0 = Math.max(z - half, resolved.zMin);
  const z1 = Math.min(z + half, resolved.zMax);
  const inlandLo = resolved.inlandMin - fade;
  const inlandHi = resolved.inlandMax + fade;
  // Three point samples can miss a coastline extremum inside the tile. The
  // derivative of each sine is bounded by |amplitude * frequency|, so this
  // midpoint interval conservatively contains every coast sample in the tile.
  const curve = resolveCoastConfig(sea).coast.curve;
  const slope = Math.abs(curve.longAmplitude * curve.longFrequency)
    + Math.abs(curve.shortAmplitude * curve.shortFrequency);
  const middle = coastX((z0 + z1) / 2, sea);
  const extent = slope * (z1 - z0) / 2;
  return middle + extent - (x - half) >= inlandLo
    && middle - extent - (x + half) <= inlandHi;
}

export function invalidateOverlappingGrassTiles(tiles, tileSize, region, sea, edge) {
  let count = 0;
  for (const tile of tiles ?? []) {
    if (!tile?.mesh) continue;
    if (!coastalJungleRegionOverlapsTile(tile.mesh.position.x, tile.mesh.position.z, tileSize, region, sea, edge)) continue;
    tile.invalidate();
    count += 1;
  }
  return count;
}
