export {
  coastalJungleRegionCenter,
  coastalJungleRegionRadius,
  coastalJungleRegionWeight,
} from '../world/CoastalJungleRegion.js';

const KIND_ORDER = [
  'background_tree',
  'split_leaf',
  'groundcover',
  'broadleaf',
  'grass',
  'fern',
  'palm',
  'tree',
  'shrub',
  'vine',
  'climber',
];

function normalizedName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

export function classifyCoastalJungleName(value) {
  const name = normalizedName(value);
  if (!name) return null;
  if (name.includes('distantunderstory') || name.includes('distant_understory')) return 'shrub';
  if (name.includes('foregroundpalm') || name.includes('foreground_palm')) return 'palm';
  for (const kind of KIND_ORDER) {
    if (name.includes(kind)) return kind;
  }
  return null;
}

export function classifyCoastalJungleObject(object) {
  const names = [];
  for (let current = object; current; current = current.parent) {
    if (current.name) names.push(current.name);
  }
  return classifyCoastalJungleName(names.join(' '));
}

// The terrain the authored scene was built on (the source world's
// elevation()). Every authored plant stands on it, so the
// height above it is what an instance keeps on the live terrain: vines stay
// hung from their branches and everything else stays on the ground.
export function coastalJungleSourceElevation(x, z) {
  const y = -z;
  return 0.065 * (y + 10) + 0.36 * Math.sin(x * 0.15) * Math.cos(y * 0.12) + 0.12 * Math.sin(y * 0.3);
}

// The authored scene keeps its own meters, so its spacing matches the
// original: it is turned by region.yaw about its origin, which lands on
// region.origin, and the strip crops it rather than squeezing it in.
export function resolveCoastalJungleFrame(region) {
  const x = Number(region?.origin?.[0]);
  const z = Number(region?.origin?.[1]);
  const yaw = Number(region?.yaw ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return null;
  return { x, z, yaw, cos: Math.cos(yaw), sin: Math.sin(yaw) };
}

// The strip can be wider than the authored scene. region.tiles lays further
// copies of it beside the first, each turned by its own yaw; every copy then
// keeps only what falls inside its own tileSize square, so they meet without
// overlapping. The first frame is the authored placement.
export function resolveCoastalJungleFrames(region) {
  const primary = resolveCoastalJungleFrame(region);
  if (!primary) return [];
  const tiles = (region?.tiles ?? []).map((tile) => resolveCoastalJungleFrame(tile));
  if (tiles.some((tile) => !tile)) return [];
  return [primary, ...tiles.map((tile) => ({ ...tile, tile: true }))];
}

export function coastalJungleTileKeeps(source, tileSize) {
  const half = Number(tileSize) * 0.5;
  if (!(half > 0)) return true;
  return Math.abs(source.x) <= half && Math.abs(source.z) <= half;
}

// Same rotation as Matrix4.makeRotationY(frame.yaw), so authored instance
// orientations turn with their positions.
export function mapCoastalJungleHorizontal(source, frame) {
  const x = Number(source?.x);
  const z = Number(source?.z);
  if (!frame || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  return {
    x: frame.x + frame.cos * x + frame.sin * z,
    z: frame.z - frame.sin * x + frame.cos * z,
  };
}

// Across the strip's edge band the jungle thins out as the surrounding biome
// thins in, so the two overlap only there. `fraction` is a stable per-plant
// value in [0, 1).
export function coastalJungleEdgeKeeps(weight, fraction) {
  return weight >= 1 || fraction < weight;
}

export function sampleCoastalJungleSlope(terrain, x, z, distance = 2) {
  const d = Math.max(0.1, Number(distance) || 2);
  const left = terrain.sampleHeight(x - d, z);
  const right = terrain.sampleHeight(x + d, z);
  const back = terrain.sampleHeight(x, z - d);
  const front = terrain.sampleHeight(x, z + d);
  if (![left, right, back, front].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
  const dx = (right - left) / (2 * d);
  const dz = (front - back) / (2 * d);
  return Math.hypot(dx, dz);
}

export function evaluateCoastalJunglePlacement({ x, z, terrain, expansion, settings = {}, waterLevel = null }) {
  if (!terrain || !Number.isFinite(x) || !Number.isFinite(z)) {
    return { allowed: false, height: 0, slope: Number.POSITIVE_INFINITY, path: 0, riverEdge: Infinity };
  }
  if (typeof terrain.contains === 'function' && !terrain.contains(x, z, settings.boundsPadding ?? 1)) {
    return { allowed: false, height: 0, slope: Number.POSITIVE_INFINITY, path: 0, riverEdge: Infinity };
  }
  const height = terrain.sampleHeight(x, z);
  const slope = sampleCoastalJungleSlope(terrain, x, z, settings.slopeSampleDistance);
  const path = expansion?.paths?.sample?.(x, z) ?? 0;
  const riverEdge = expansion?.river?.sample?.(x, z)?.edge ?? Number.POSITIVE_INFINITY;
  const allowed = Number.isFinite(height)
    && slope <= Number(settings.maxSlope ?? 0.75)
    && path <= Number(settings.routeMaskMax ?? 0.08)
    && riverEdge >= Number(settings.riverClearance ?? 10)
    // Where the strip runs down to the lake, nothing stands in the water.
    && !(Number.isFinite(waterLevel) && height < waterLevel + Number(settings.waterClearance ?? 0.4));
  return { allowed, height, slope, path, riverEdge };
}
