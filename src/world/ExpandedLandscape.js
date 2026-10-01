import * as THREE from 'three';
import { RiverCourse } from '../water/RiverCourse.js';
import { fractalNoise, hash2d } from '../grass/vegetationEcology.js';
import { createSeededRandom } from '../core/math.js';
import { LandscapePaths, forestWeight } from './LandscapePaths.js';
import { createPathLanternPairs } from './PathLanterns.js';
import { createAlpineTrees } from './AlpineTrees.js';
import { coastDistanceAt, coastalHeight, sampleCoastField } from './CoastField.js';
import { coastalJungleProfileWeight } from './CoastalJungleRegion.js';
import {
  alpineTreeAllowed,
  resolveAlpineConfig,
  shapeAlpineHeight,
} from './AlpineRegion.js';
import { refineTerrainRegion } from './TerrainRefinement.js';
import { lakeBoundsContain, lakeSignedDistance, resolveLakeShape, shapeLakeHeight } from './LakeShape.js';
import { sampleSnowSurfaceCpu } from './SnowDeformationField.js';
import { mountainRelief } from './MountainNoise.js';

const smooth = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);
// Alpine triangles spanning more height than this get one more subdivision:
// steep faces on the alpine grid otherwise show as sawtooth crests and
// stretched facets, and the gorge walls are full of them.
const STEEP_TRIANGLE_RISE = 4.5;
const LAKE_REFINEMENT_MARGIN = 12;
const RIVER_REFINEMENT_MIN_REACH = 12;
const RIVER_REFINEMENT_BANK_PADDING = 5;
// Dry bank a trunk needs between itself and any water edge, and how far its base
// must stand above that water surface.
const WATER_CLEARANCE = 6;
const WATER_FREEBOARD = 1.5;
const insideBounds = (x, z, b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;

const MOUNTAIN_PEAKS = [[10, -685, 95, 95, 110], [-85, -620, 115, 120, 155], [175, -575, 125, 145, 145],
  [35, -380, 170, 140, 67], [-525, -330, 165, 210, 110], [540, -490, 165, 180, 115]];
// The ranges stand on the unrefined world grid, so their relief is cut to the
// octaves that grid can carry: at 0.0055 they are 182, 91 and 44 m across, and
// the five-metre grid needs about eight cells per feature. The two dropped
// ones (22 and 11 m) only arrived as facets and as ridgelines that stepped
// from vertex to vertex. Same budget as terrain.alpine.landform.relief.octaves.
const MOUNTAIN_RELIEF_OCTAVES = 3;

export function mountainHeight(x, z) {
  let height = 0;
  for (const [px, pz, sx, sz, amplitude] of MOUNTAIN_PEAKS) {
    // A cusp at the summit and concave flanks, instead of a Gaussian dome.
    const r = Math.hypot((x - px) / sx, (z - pz) / sz);
    height += amplitude * Math.exp(-r * 0.55 - r * r * 0.6);
  }
  // Warped so ridgelines bend and branch rather than following the noise grid.
  const wx = x + (fractalNoise(x * 0.003, z * 0.003, 211, 3) - 0.5) * 140;
  const wz = z + (fractalNoise(x * 0.003, z * 0.003, 223, 3) - 0.5) * 140;
  return height * (0.4 + mountainRelief(wx * 0.0055, wz * 0.0055, 173, MOUNTAIN_RELIEF_OCTAVES) * 1.3);
}

function corridorEdgeKey(a, b, stride) {
  return a < b ? a * stride + b : b * stride + a;
}

function addCorridorMidpoint(positions, uvs, edges, splitVertices, carveVertices, stride, a, b) {
  const key = corridorEdgeKey(a, b, stride);
  if (edges.has(key)) {
    carveVertices.add(edges.get(key));
    return;
  }
  const vertex = positions.length / 3;
  edges.set(key, vertex);
  carveVertices.add(vertex);
  splitVertices[a] = 1;
  splitVertices[b] = 1;

  const ap = a * 3;
  const bp = b * 3;
  positions.push(
    (positions[ap] + positions[bp]) * 0.5,
    (positions[ap + 1] + positions[bp + 1]) * 0.5,
    (positions[ap + 2] + positions[bp + 2]) * 0.5,
  );
  const au = a * 2;
  const bu = b * 2;
  uvs.push(
    (uvs[au] + uvs[bu]) * 0.5,
    (uvs[au + 1] + uvs[bu + 1]) * 0.5,
  );
}

function appendCorridorSplit(next, a, b, c, ab, bc, ca) {
  const hasAb = ab !== undefined;
  const hasBc = bc !== undefined;
  const hasCa = ca !== undefined;
  const count = Number(hasAb) + Number(hasBc) + Number(hasCa);

  if (count === 0) {
    next.push(a, b, c);
    return;
  }
  if (count === 3) {
    next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    return;
  }

  if (count === 1) {
    if (hasAb) next.push(a, ab, c, ab, b, c);
    else if (hasBc) next.push(b, bc, a, bc, c, a);
    else next.push(c, ca, b, ca, a, b);
    return;
  }

  if (hasAb && hasBc) next.push(a, ab, c, ab, bc, c, ab, b, bc);
  else if (hasBc && hasCa) next.push(b, bc, a, bc, ca, a, bc, c, ca);
  else next.push(c, ca, b, ca, ab, b, ca, a, ab);
}

// Conforming subdivision: shared edges are split once, including adjacent triangles.
function refineCorridor(positions, uvs, indices, river) {
  const carveVertices = new Set();
  for (let pass = 0; pass < 2; pass += 1) {
    // Endpoints in this pass all predate the new midpoint vertices, so one
    // numeric key is collision-free and avoids millions of temporary strings.
    const stride = positions.length / 3;
    const edges = new Map();
    const splitVertices = new Uint8Array(stride);
    const bounds = river.sampleBounds;

    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i];
      const b = indices[i + 1];
      const c = indices[i + 2];
      const ap = a * 3;
      const bp = b * 3;
      const cp = c * 3;
      const x = (positions[ap] + positions[bp] + positions[cp]) / 3;
      const z = (positions[ap + 2] + positions[bp + 2] + positions[cp + 2]) / 3;
      if (x < bounds.minX || x >= bounds.maxX || z < bounds.minZ || z >= bounds.maxZ) continue;
      if (!river.intersectsRefinementBand(
        x,
        z,
        RIVER_REFINEMENT_MIN_REACH,
        RIVER_REFINEMENT_BANK_PADDING,
      )) continue;

      carveVertices.add(a);
      carveVertices.add(b);
      carveVertices.add(c);
      addCorridorMidpoint(positions, uvs, edges, splitVertices, carveVertices, stride, a, b);
      addCorridorMidpoint(positions, uvs, edges, splitVertices, carveVertices, stride, b, c);
      addCorridorMidpoint(positions, uvs, edges, splitVertices, carveVertices, stride, c, a);
    }

    if (edges.size === 0) break;
    const next = [];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i];
      const b = indices[i + 1];
      const c = indices[i + 2];
      if (splitVertices[a] + splitVertices[b] + splitVertices[c] < 2) {
        next.push(a, b, c);
        continue;
      }

      const ab = splitVertices[a] && splitVertices[b]
        ? edges.get(corridorEdgeKey(a, b, stride)) : undefined;
      const bc = splitVertices[b] && splitVertices[c]
        ? edges.get(corridorEdgeKey(b, c, stride)) : undefined;
      const ca = splitVertices[c] && splitVertices[a]
        ? edges.get(corridorEdgeKey(c, a, stride)) : undefined;
      appendCorridorSplit(next, a, b, c, ab, bc, ca);
    }
    indices = next;
  }
  return { indices, carveVertices };
}

function createLandscapeContext(original, config) {
  const settings = config.terrain.expansion;
  if (!settings?.enabled) return null;
  const alpine = resolveAlpineConfig(config);
  const alpineRefineRadiusSquared = alpine ? alpine.refineRadius * alpine.refineRadius : 0;
  const insideAlpineRefinement = (x, z) => {
    const dx = x - alpine.centerX;
    const dz = z - alpine.centerZ;
    return dx * dx + dz * dz <= alpineRefineRadiusSquared;
  };
  const lake = resolveLakeShape(config);
  const width = settings.width ?? settings.size;
  const depth = settings.depth ?? settings.size;
  const [centerX, centerZ] = settings.center ?? [0, 0];
  const naturalHeight = (x, z) => {
    const cx = THREE.MathUtils.clamp(x, original.bounds.min.x, original.bounds.max.x);
    const cz = THREE.MathUtils.clamp(z, original.bounds.min.z, original.bounds.max.z);
    const edgeDistance = Math.hypot(x - cx, z - cz);
    let base;
    if (edgeDistance <= 0) {
      base = original.sampleHeight(cx, cz);
    } else {
      const outer = 14 + fractalNoise(x * 0.007, z * 0.007, 64, 4) * 24;
      if (edgeDistance >= 170) base = outer;
      else {
        const old = original.sampleHeight(cx, cz);
        base = THREE.MathUtils.lerp(old, outer, smooth(0, 170, edgeDistance));
      }
    }

    const mountainWeight = smooth(210, 325, -z);
    const mountain = mountainWeight > 0 ? base + mountainHeight(x, z) * mountainWeight : base;
    const coast = coastalHeight(x, z, mountain, config.water.sea);
    return shapeLakeHeight(x, z, shapeAlpineHeight(x, z, coast, alpine), lake);
  };
  const routes = [...(settings.routes ?? [])];
  if (alpine?.route) routes.push(alpine.route);
  const paths = new LandscapePaths(
    width,
    depth,
    centerX,
    centerZ,
    config.water.sea?.enabled,
    routes,
    naturalHeight,
  );
  const baseHeight = (x, z) => paths.conformHeight(x, z, naturalHeight(x, z));
  const river = config.water.river?.enabled
    ? new RiverCourse(config.water.river, baseHeight, config.water.position[1])
    : null;
  return {
    settings,
    alpine,
    lake,
    width,
    depth,
    centerX,
    centerZ,
    insideAlpineRefinement,
    naturalHeight,
    paths,
    baseHeight,
    river,
  };
}

function installExpandedLandscape(target, original, context, geometry) {
  const previous = target.geometry;
  target.geometry = geometry;
  context.paths.createTexture();
  context.river?.createTexture();
  return {
    river: context.river,
    paths: context.paths,
    original,
    baseHeight: context.baseHeight,
    naturalHeight: context.naturalHeight,
    alpine: context.alpine,
    lake: context.lake,
    dispose() {
      target.geometry = previous;
      geometry.dispose();
      context.river?.dispose();
      context.paths.dispose();
      original.texture?.dispose();
    },
  };
}

export function createExpandedLandscapeFromGeometry(target, original, config, geometry) {
  if (!target?.isMesh || !geometry) return null;
  const context = createLandscapeContext(original, config);
  if (!context) return null;
  return installExpandedLandscape(target, original, context, geometry);
}

export function expandLandscape(target, original, config) {
  if (!target?.isMesh) return null;
  const context = createLandscapeContext(original, config);
  if (!context) return null;
  const {
    alpine,
    lake,
    width,
    depth,
    centerX,
    centerZ,
    insideAlpineRefinement,
    baseHeight,
    river,
  } = context;
  const segmentsX = Math.round(width / 5), segmentsZ = Math.round(depth / 5);
  const positions = [], uvs = [], indices = [];
  for (let j = 0; j <= segmentsZ; j++) for (let i = 0; i <= segmentsX; i++) {
    const x = centerX - width / 2 + i / segmentsX * width, z = centerZ - depth / 2 + j / segmentsZ * depth;
    positions.push(x, baseHeight(x, z), z);
    // Keep the original texture density and authored path projection in world space.
    uvs.push((x + 480) / 960, 1 - (z + 480) / 960);
  }
  for (let j = 0; j < segmentsZ; j++) for (let i = 0; i < segmentsX; i++) {
    const a = j * (segmentsX + 1) + i, b = a + 1, c = a + segmentsX + 1, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }

  let refined = indices;
  if (alpine?.refinePasses > 0) {
    refined = refineTerrainRegion({
      positions,
      uvs,
      indices: refined,
      passes: alpine.refinePasses,
      shouldRefine: (x, z) => insideAlpineRefinement(x, z),
      sampleHeight: baseHeight,
    });
    refined = refineTerrainRegion({
      positions,
      uvs,
      indices: refined,
      passes: 1,
      shouldRefine: (x, z, a, b, c) => {
        if (!insideAlpineRefinement(x, z)) return false;
        const ay = positions[a * 3 + 1];
        const by = positions[b * 3 + 1];
        const cy = positions[c * 3 + 1];
        return Math.max(ay, by, cy) - Math.min(ay, by, cy) > STEEP_TRIANGLE_RISE;
      },
      sampleHeight: baseHeight,
    });
  }
  // One more subdivision along the lake shore, so the bank is not a 5 m staircase.
  if (lake) {
    refined = refineTerrainRegion({
      positions,
      uvs,
      indices: refined,
      passes: 1,
      shouldRefine: (x, z) => lakeBoundsContain(x, z, lake, LAKE_REFINEMENT_MARGIN)
        && Math.abs(lakeSignedDistance(x, z, lake)) <= LAKE_REFINEMENT_MARGIN,
      sampleHeight: baseHeight,
    });
  }
  let riverCarveVertices = null;
  if (river) {
    const corridor = refineCorridor(positions, uvs, refined, river);
    refined = corridor.indices;
    riverCarveVertices = corridor.carveVertices;
  }
  if (river) {
    for (const vertex of riverCarveVertices) {
      const i = vertex * 3;
      positions[i + 1] = river.carve(positions[i], positions[i + 2], positions[i + 1]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(refined);
  target.updateWorldMatrix(true, false);
  geometry.applyMatrix4(target.matrixWorld.clone().invert());
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return installExpandedLandscape(target, original, context, geometry);
}

export function adaptLandscapeRecords(trees, props, expansion, terrain) {
  if (!expansion) return { trees, props };
  const { original, river, alpine, lake } = expansion;
  const rebase = records => (records ?? []).filter(p => !river || (river.sample(p[0], p[2])?.edge ?? 100) > 5)
    .map(p => {
      const record = [...p];
      record[1] += terrain.sampleHeight(p[0], p[2]) - original.sampleHeight(p[0], p[2]);
      return record;
    });
  const snowAt = (x, z) => sampleSnowSurfaceCpu(terrain, x, z, 2, terrain.config)?.coverage ?? 0;
  const allowed = (x, y, z) => alpineTreeAllowed(x, y, z, alpine, snowAt(x, z));
  // Nothing grows in water. A trunk must stand WATER_CLEARANCE metres of dry bank
  // back from the river channel, the lake outline (whose surface reaches `margin`
  // under the banks) and the shoreline, and its base must sit WATER_FREEBOARD above
  // the surface it stands beside, which is what rules out the shallow margins.
  const sea = terrain.config.water.sea;
  const dryGround = (x, y, z) => {
    if ((river?.sample(x, z)?.edge ?? Infinity) < WATER_CLEARANCE) return false;
    if (lake && (lakeSignedDistance(x, z, lake) < lake.margin + WATER_CLEARANCE
      || (insideBounds(x, z, lake.bounds) && y < lake.level + WATER_FREEBOARD))) return false;
    if (sea?.enabled && (coastDistanceAt(x, z, sea) > -WATER_CLEARANCE || y < sea.level + WATER_FREEBOARD)) return false;
    return true;
  };
  const result = rebase(trees).filter(p => allowed(p[0], p[1], p[2]));
  const random = createSeededRandom(29173);
  for (let z = terrain.bounds.min.z + 30; z < terrain.bounds.max.z - 30; z += 28) {
    for (let x = terrain.bounds.min.x + 30; x < terrain.bounds.max.x - 30; x += 28) {
      const px = x + random() * 20, pz = z + random() * 20;
      if (Math.abs(px) < 465 && Math.abs(pz) < 465) continue;
      const py = terrain.sampleHeight(px, pz);
      const sea = terrain.config.water.sea;
      if (sea?.enabled && sampleCoastField(px, pz, 0, sea).signedCoastDistance > -105) continue;
      const slope = Math.hypot(terrain.sampleHeight(px + 3, pz) - py, terrain.sampleHeight(px, pz + 3) - py) / 3;
      if (py < -15 || py > 100 || slope > 0.65 || random() > 0.55 || (river?.sample(px, pz)?.edge ?? 100) < 9) continue;
      if (!allowed(px, py, pz)) continue;
      result.push([px, py, pz, random() * Math.PI * 2, 0.8 + random() * 0.5, Math.floor(random() * 9)]);
    }
  }
  const occupied = new Set(result.map(p => `${Math.round(p[0] / 12)},${Math.round(p[2] / 12)}`));
  for (let z = -225; z < 255; z += 15) for (let x = -500; x < -65; x += 15) {
    const px = x + random() * 9, pz = z + random() * 9;
    if (random() > forestWeight(px, pz) * 0.85 || expansion.paths.sample(px, pz) > 0.05) continue;
    const key = `${Math.round(px / 12)},${Math.round(pz / 12)}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    const py = terrain.sampleHeight(px, pz);
    if (!allowed(px, py, pz)) continue;
    result.push([px, py, pz, random() * Math.PI * 2, 1.05 + random() * 0.65, Math.floor(random() * 9)]);
  }
  result.push(...createAlpineTrees(alpine, terrain, expansion.paths, {
    clearings: (terrain.config.navigation?.locations ?? [])
      .filter(location => location.mode === 'ground').map(location => location.position),
    windAngleDegrees: terrain.config.ground?.snow?.wind?.angleDegrees,
  }));
  // The coastal jungle grows its own forest. Broadleaf trees reach only into
  // its edge band, thinning out there as the jungle thins in.
  const outsideJungle = p => hash2d(Math.floor(p[0] * 4), Math.floor(p[2] * 4), 7121)
    >= coastalJungleProfileWeight(p[0], p[2], terrain.config);
  return { trees: result.filter(p => outsideJungle(p) && dryGround(p[0], p[1], p[2])), props: { stones: rebase(props.stones),
    lanterns: createPathLanternPairs(rebase(props.lanterns), expansion.paths, terrain, river) } };
}
