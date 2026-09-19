import { fractalNoise } from '../grass/vegetationEcology.js';

// A lake drawn as a centreline of [x, z, halfWidth] points. The terrain is
// carved to it (bed, shelving banks) and the old basin it replaces is filled,
// so the water surface can follow the same outline instead of a square.
const SUBDIVISIONS = 8;

function smoothstep(min, max, value) {
  if (max <= min) return value >= max ? 1 : 0;
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return t * t * (3 - 2 * t);
}

// Polynomial smooth minimum: the lower of a and b, rounded over k metres.
function smoothMin(a, b, k) {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

function finite(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? number : fallback;
}

// Catmull-Rom through the authored points, so bends are round rather than
// the corners of a polyline.
function smoothCentreline(points) {
  if (points.length < 3) return points;
  const out = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let step = 0; step < SUBDIVISIONS; step += 1) {
      const t = step / SUBDIVISIONS, t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map(c => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t
        + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2
        + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3)));
    }
  }
  out.push(points.at(-1));
  return out;
}

export function resolveLakeShape(config) {
  const settings = config?.water?.lake;
  if (!settings || settings.enabled === false) return null;
  const level = Number(config.water?.position?.[1]);
  const points = (settings.points ?? []).map(point => point.map(Number));
  if (!Number.isFinite(level) || points.length < 2
    || !points.every(point => point.length === 3 && point.every(Number.isFinite) && point[2] > 0)) {
    throw new Error('water.lake needs a finite water.position level and at least two [x, z, halfWidth] points.');
  }
  const centreline = smoothCentreline(points);
  const wobble = Math.max(0, finite(settings.shoreWobble, 0));
  const bankWidth = Math.max(1, finite(settings.bankWidth, 60));
  const margin = Math.max(0, finite(settings.waterMargin, 8));
  const reach = Math.max(bankWidth, margin) + wobble;
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const [x, z, radius] of centreline) {
    bounds.minX = Math.min(bounds.minX, x - radius - reach);
    bounds.maxX = Math.max(bounds.maxX, x + radius + reach);
    bounds.minZ = Math.min(bounds.minZ, z - radius - reach);
    bounds.maxZ = Math.max(bounds.maxZ, z + radius + reach);
  }
  const fill = settings.fill?.bounds?.length === 4 ? {
    bounds: settings.fill.bounds.map(Number),
    rise: Math.max(0, finite(settings.fill.rise, 6)),
    fade: Math.max(1, finite(settings.fill.fade, 30)),
  } : null;
  return {
    level,
    centreline,
    bounds,
    depth: Math.max(0.5, finite(settings.depth, 6)),
    shelf: Math.max(1, finite(settings.shelf, 20)),
    shoreDepth: Math.max(0, finite(settings.shoreDepth, 0.5)),
    bankWidth,
    bankSlope: Math.max(0.01, finite(settings.bankSlope, 0.4)),
    bankSoftness: Math.max(0.1, finite(settings.bankSoftness, 4)),
    wobble,
    margin,
    fill,
  };
}

// Negative inside the water, positive on land, in metres from the shoreline.
export function lakeSignedDistance(x, z, lake) {
  const line = lake.centreline;
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i += 1) {
    const [ax, az, ar] = line[i], [bx, bz, br] = line[i + 1];
    const dx = bx - ax, dz = bz - az;
    const length = dx * dx + dz * dz;
    const t = length > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length)) : 0;
    const distance = Math.hypot(x - ax - dx * t, z - az - dz * t) - (ar + (br - ar) * t);
    if (distance < best) best = distance;
  }
  if (!lake.wobble) return best;
  return best + (fractalNoise(x * 0.018, z * 0.018, 911, 3) * 2 - 1) * lake.wobble;
}

// How much the old basin is raised at a point: the fill's bounds fade out at
// their edges so the meadow meets the surrounding ground without a seam.
function fillWeight(x, z, fill) {
  const [minX, minZ, maxX, maxZ] = fill.bounds;
  const inside = Math.min(x - minX, maxX - x, z - minZ, maxZ - z);
  return smoothstep(0, fill.fade, inside);
}

// Carves the bed inside the shoreline, ramps the banks up at bankSlope until
// they meet the existing ground and fills any part of the old basin the new
// outline leaves on land. bankWidth only bounds the work: it must be long
// enough for the ramp to reach the highest ground beside the lake.
export function shapeLakeHeight(x, z, height, lake) {
  if (!lake) return height;
  const { bounds, fill } = lake;
  const inBounds = x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
  let target = height;
  if (fill) {
    const weight = fillWeight(x, z, fill);
    if (weight > 0) {
      const distance = inBounds ? lakeSignedDistance(x, z, lake) : Infinity;
      const floor = lake.level + Math.min(fill.rise, 0.8 + Math.max(0, distance) * 0.06)
        + (fractalNoise(x * 0.03, z * 0.03, 412, 3) - 0.5) * 1.6;
      target = Math.max(height, height + (floor - height) * weight);
    }
  }
  if (!inBounds) return target;
  const distance = lakeSignedDistance(x, z, lake);
  if (distance <= 0) {
    const bed = lake.level - lake.shoreDepth - lake.depth * smoothstep(0, lake.shelf, -distance);
    return Math.min(height, bed);
  }
  if (distance >= lake.bankWidth) return target;
  const ramp = lake.level - lake.shoreDepth + distance * lake.bankSlope;
  return smoothMin(target, ramp, lake.bankSoftness);
}
