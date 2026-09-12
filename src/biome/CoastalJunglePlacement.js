import { coastX } from '../world/CoastField.js';

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

const MIN_SPAN = 0.001;
const REGION_RADIUS_SAMPLES = 8;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function normalize(value, min, max) {
  return clamp01((value - min) / Math.max(MIN_SPAN, max - min));
}

function normalizedName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function finiteRegion(region) {
  if (!region) return null;
  const values = ['zStart', 'zEnd', 'inlandStart', 'inlandEnd']
    .map((key) => Number(region[key]));
  if (!values.every(Number.isFinite)) return null;
  const [zStart, zEnd, inlandStart, inlandEnd] = values;
  if (Math.abs(zEnd - zStart) < MIN_SPAN || Math.abs(inlandEnd - inlandStart) < MIN_SPAN) return null;
  return { zStart, zEnd, inlandStart, inlandEnd };
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

export function createCoastalJungleSourceBounds(points) {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const point of points ?? []) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.z)) continue;
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) return null;
  return { minX, maxX, minZ, maxZ };
}

export function mapCoastalJungleHorizontal(source, bounds, region, sea) {
  if (!bounds || !region || !sea) return null;
  let across = normalize(source.x, bounds.minX, bounds.maxX);
  let along = normalize(source.z, bounds.minZ, bounds.maxZ);
  if (region.flipAcross) across = 1 - across;
  if (region.flipAlong) along = 1 - along;
  const z = Number(region.zStart) + (Number(region.zEnd) - Number(region.zStart)) * along;
  const inland = Number(region.inlandStart)
    + (Number(region.inlandEnd) - Number(region.inlandStart)) * across;
  if (!Number.isFinite(z) || !Number.isFinite(inland)) return null;
  return { x: coastX(z, sea) - inland, z, inland };
}

export function coastalJungleRegionCenter(region, sea) {
  const resolved = finiteRegion(region);
  if (!resolved || !sea) return null;
  const z = (resolved.zStart + resolved.zEnd) * 0.5;
  const inland = (resolved.inlandStart + resolved.inlandEnd) * 0.5;
  return { x: coastX(z, sea) - inland, z };
}

export function coastalJungleRegionRadius(region, sea) {
  const resolved = finiteRegion(region);
  const center = coastalJungleRegionCenter(region, sea);
  if (!resolved || !center) return 0;
  const inlandValues = [resolved.inlandStart, resolved.inlandEnd];
  let radius = 0;
  for (let index = 0; index <= REGION_RADIUS_SAMPLES; index += 1) {
    const t = index / REGION_RADIUS_SAMPLES;
    const z = resolved.zStart + (resolved.zEnd - resolved.zStart) * t;
    for (const inland of inlandValues) {
      const x = coastX(z, sea) - inland;
      radius = Math.max(radius, Math.hypot(x - center.x, z - center.z));
    }
  }
  return radius;
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

export function evaluateCoastalJunglePlacement({ x, z, terrain, expansion, settings = {} }) {
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
    && riverEdge >= Number(settings.riverClearance ?? 10);
  return { allowed, height, slope, path, riverEdge };
}
