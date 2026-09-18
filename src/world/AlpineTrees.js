import { fractalNoise, hash2d, smoothstep } from '../grass/vegetationEcology.js';
import { ALPINE_CONIFER_SNOW, alpineDistance } from './AlpineRegion.js';
import { sampleSnowSurfaceCpu } from './SnowDeformationField.js';

// Tree type indices (Tree10..Tree13 in the config's tree types).
export const ALPINE_TREE_TYPES = Object.freeze({ spruce: 9, pine: 10, young: 11, fir: 12 });

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
    // Tree lines along a route, where the ground already leans toward a grove.
    if (nearPath(paths, px, pz, PATH_FRAMING)) density = Math.max(density, 0.5 * smoothstep(0.38, 0.52, grove));
    // A few stragglers out in the open.
    density = Math.max(density, 0.035);
    // Ground above the basin floor is exposed: it thins the stand and stunts it.
    const exposure = smoothstep(alpine.basinHeight - 4, ceiling, y);
    density *= 1 - 0.45 * exposure;
    if (random(2) > density) continue;

    const pick = random(3);
    let type = ALPINE_TREE_TYPES.spruce;
    if (pick < 0.12 + 0.3 * (1 - core)) type = ALPINE_TREE_TYPES.young;
    else if (exposure > 0.35 && pick < 0.3 + 0.5 * exposure) type = ALPINE_TREE_TYPES.pine;
    else if (pick > 0.86 - 0.12 * exposure) type = ALPINE_TREE_TYPES.fir;
    // Grove cores grow the tallest trees; exposed ground stunts them.
    const scale = (0.8 + random(4) * 0.55) * (0.85 + 0.5 * core) * (1 - 0.3 * exposure);
    if (!spacingClear(px, pz, scale)) continue;
    // Wind-flagged trees all lean their long boughs downwind.
    const flagged = type === ALPINE_TREE_TYPES.pine || type === ALPINE_TREE_TYPES.fir;
    const rotation = flagged ? windRotation + (random(5) - 0.5) * 0.6 : random(5) * Math.PI * 2;
    const key = `${Math.floor(px / 8)},${Math.floor(pz / 8)}`;
    if (!trunks.has(key)) trunks.set(key, []);
    trunks.get(key).push([px, pz, scale]);
    result.push([px, y, pz, rotation, scale, type]);
  }
  return result;
}
