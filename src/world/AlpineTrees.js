import { fractalNoise, hash2d, smoothstep } from '../grass/vegetationEcology.js';
import { ALPINE_CONIFER_SNOW, alpineDistance } from './AlpineRegion.js';
import { sampleSnowSurfaceCpu } from './SnowDeformationField.js';

// Tree type indices (Tree10..Tree19 in the config's tree types).
export const ALPINE_TREE_TYPES = Object.freeze({
  spruce: 9, pine: 10, young: 11, fir: 12, spire: 13, broad: 14, pruned: 15, laden: 16, dying: 17, sapling: 18,
});
const T = ALPINE_TREE_TYPES;
// Relative weights of each family in a dense grove core, at a grove's edge and
// on exposed ground. A dense stand shades out its lower boughs; edges fill with
// young growth and snow-bowed trees; exposed ground keeps the wind-shaped ones.
const MIX = Object.freeze({
  core: [[T.spruce, 26], [T.broad, 18], [T.spire, 20], [T.pruned, 22], [T.dying, 5], [T.young, 6], [T.fir, 3]],
  edge: [[T.spruce, 20], [T.young, 20], [T.sapling, 14], [T.laden, 22], [T.spire, 10], [T.broad, 6], [T.dying, 4], [T.fir, 4]],
  exposed: [[T.pine, 32], [T.fir, 20], [T.laden, 14], [T.dying, 14], [T.young, 10], [T.sapling, 6], [T.spruce, 4]],
});
// Trunk spacing per family, relative to TRUNK_SPACING: saplings crowd in under
// their elders, broad trees need room.
const SPACING = Object.freeze({ [T.sapling]: 0.35, [T.young]: 0.6, [T.laden]: 0.85, [T.broad]: 1.35, [T.spire]: 0.8 });
// Height scale ranges per family, on top of the grove and exposure scaling.
const SCALE = Object.freeze({ [T.sapling]: [0.6, 1.3], [T.young]: [0.7, 1.2], [T.broad]: [0.85, 1.15], [T.spire]: [0.8, 1.2] });
// Families that grow bent: the most a trunk leans, in radians.
const LEAN = Object.freeze({ [T.pine]: 0.1, [T.fir]: 0.08, [T.dying]: 0.09, [T.sapling]: 0.07, [T.pruned]: 0.05 });

const CELL = 7;
const SEED = 73019;
// Trees keep this far from a route's centreline, and a route draws tree lines
// out to the framing distance.
const PATH_CLEARANCE = 7;
const PATH_FRAMING = 16;
// No tree stands within this radius of an alpine teleport destination.
const CLEARING_RADIUS = 16;
// Trunks stay this many metres apart per unit of tree scale.
const TRUNK_SPACING = 3.4;
const RING = Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)]);

function nearPath(paths, x, z, radius) {
  if (paths.sample(x, z) > 0.01) return true;
  return RING.some(([dx, dz]) => paths.sample(x + dx * radius, z + dz * radius) > 0.01
    || paths.sample(x + dx * radius * 0.5, z + dz * radius * 0.5) > 0.01);
}

/**
 * Snow conifers grow in groves: dense, overlapping stands with clearings
 * between them, tree lines along the walked routes and a few stragglers in the
 * open. Each candidate cell draws its own hashed random numbers, so extending
 * or reshaping one part of the terrain never reshuffles the trees elsewhere.
 *
 * Records are `[x, y, z, rotationY, scale, typeIndex]`.
 */
export function createAlpineTrees(alpine, terrain, paths, { clearings = [], windAngleDegrees = 150 } = {}) {
  if (!alpine) return [];
  const result = [];
  const trunks = new Map();
  const windRotation = -windAngleDegrees * Math.PI / 180;
  const ceiling = alpine.basinHeight + 28;
  const radius = alpine.outerRadius;
  const [x0, x1] = [Math.floor((alpine.centerX - radius) / CELL), Math.ceil((alpine.centerX + radius) / CELL)];
  const [z0, z1] = [Math.floor((alpine.centerZ - radius) / CELL), Math.ceil((alpine.centerZ + radius) / CELL)];
  const spacingClear = (x, z, scale) => {
    const reach = TRUNK_SPACING * scale;
    const cx = Math.floor(x / 8), cz = Math.floor(z / 8);
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
      for (const [tx, tz, ts] of trunks.get(`${i},${j}`) ?? []) {
        if (Math.hypot(tx - x, tz - z) < Math.max(reach, TRUNK_SPACING * ts)) return false;
      }
    }
    return true;
  };

  for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
    const random = channel => hash2d(ix * 7 + channel * 101, iz * 13 + channel * 31, SEED);
    const px = (ix + 0.1 + random(0) * 0.8) * CELL, pz = (iz + 0.1 + random(1) * 0.8) * CELL;
    if (alpineDistance(px, pz, alpine) > alpine.outerBlendStart) continue;
    const y = terrain.sampleHeight(px, pz);
    if (!Number.isFinite(y) || y > ceiling) continue;
    // Conifers stand above the tree line and wherever snow lies below it.
    if (y < alpine.treeLine && (sampleSnowSurfaceCpu(terrain, px, pz, 2, terrain.config)?.coverage ?? 0) < ALPINE_CONIFER_SNOW) continue;
    const slope = Math.hypot(terrain.sampleHeight(px + 2, pz) - y, terrain.sampleHeight(px, pz + 2) - y) / 2;
    if (slope > 0.55) continue;
    if (clearings.some(([cx, cz, r = CLEARING_RADIUS]) => Math.hypot(px - cx, pz - cz) < r)) continue;
    // Keep crowns as well as trunks outside the walking corridor.
    if (nearPath(paths, px, pz, PATH_CLEARANCE)) continue;

    // Groves from low-frequency noise, their edges frayed by a finer octave.
    const grove = fractalNoise(px * 0.016, pz * 0.016, SEED, 2) + (fractalNoise(px * 0.09, pz * 0.09, SEED + 7, 1) - 0.5) * 0.12;
    const core = smoothstep(0.52, 0.66, grove);
    let density = core * 0.95;
    // Glades open inside the larger groves.
    density *= 1 - 0.85 * core * (1 - smoothstep(0.22, 0.34, fractalNoise(px * 0.035, pz * 0.035, SEED + 23, 2)));
    // Satellite clumps of a few trees stand off a grove's edge.
    const edge = smoothstep(0.3, 0.44, grove) * (1 - core);
    const clump = smoothstep(0.62, 0.7, fractalNoise(px * 0.05, pz * 0.05, SEED + 19, 2));
    density = Math.max(density, 0.75 * clump * edge);
    // Tree lines along a route, where the ground already leans toward a grove.
    if (nearPath(paths, px, pz, PATH_FRAMING)) density = Math.max(density, 0.5 * smoothstep(0.38, 0.52, grove));
    // Lanes wind through the groves along a noise contour, so dense forest
    // always has a walkable way through it.
    const lane = Math.abs(fractalNoise(px * 0.009, pz * 0.009, SEED + 41, 2) - 0.5);
    density *= smoothstep(0.018, 0.034, lane);
    // A few stragglers out in the open.
    density = Math.max(density, 0.035);
    // Ground above the basin floor is exposed: it thins the stand and stunts it.
    const exposure = smoothstep(alpine.basinHeight - 4, ceiling, y);
    density *= 1 - 0.45 * exposure;
    if (random(2) > density) continue;

    const type = pickFamily(random(3), core, exposure);
    const [low, high] = SCALE[type] ?? [0.8, 1.35];
    // Grove cores grow the tallest trees; exposed ground stunts them.
    const scale = (low + random(4) * (high - low)) * (0.85 + 0.5 * core) * (1 - 0.3 * exposure);
    if (!spacingClear(px, pz, scale * (SPACING[type] ?? 1))) continue;
    // Wind-flagged trees all lean their long boughs downwind.
    const flagged = type === T.pine || type === T.fir || type === T.dying;
    const rotation = flagged ? windRotation + (random(5) - 0.5) * 0.6 : random(5) * Math.PI * 2;
    // A slight lean for most trees, a marked one for the bent families.
    const lean = (LEAN[type] ?? 0.025) * (0.3 + random(6) * 0.7) * (1 + exposure);
    const key = `${Math.floor(px / 8)},${Math.floor(pz / 8)}`;
    if (!trunks.has(key)) trunks.set(key, []);
    trunks.get(key).push([px, pz, scale * (SPACING[type] ?? 1)]);
    result.push([px, y, pz, rotation, scale, type, lean]);
  }
  return result;
}

function pickFamily(pick, core, exposure) {
  const weights = new Map();
  const blend = (mix, weight) => {
    const total = mix.reduce((sum, [, w]) => sum + w, 0);
    for (const [type, w] of mix) weights.set(type, (weights.get(type) ?? 0) + w / total * weight);
  };
  const exposed = smoothstep(0.25, 0.7, exposure);
  blend(MIX.core, core * (1 - exposed));
  blend(MIX.edge, (1 - core) * (1 - exposed));
  blend(MIX.exposed, exposed);
  let remaining = pick;
  for (const [type, weight] of weights) {
    remaining -= weight;
    if (remaining < 0) return type;
  }
  return T.spruce;
}
