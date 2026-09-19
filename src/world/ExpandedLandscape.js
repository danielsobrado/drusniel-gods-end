import * as THREE from 'three';
import { RiverCourse } from '../water/RiverCourse.js';
import { fractalNoise, hash2d } from '../grass/vegetationEcology.js';
import { createSeededRandom } from '../core/math.js';
import { LandscapePaths, forestWeight } from './LandscapePaths.js';
import { createPathLanternPairs } from './PathLanterns.js';
import { createAlpineTrees } from './AlpineTrees.js';
import { coastalHeight, sampleCoastField } from './CoastField.js';
import { coastalJungleProfileWeight } from './CoastalJungleRegion.js';
import {
  alpineDistance,
  alpineTreeAllowed,
  resolveAlpineConfig,
  shapeAlpineHeight,
} from './AlpineRegion.js';
import { refineTerrainRegion } from './TerrainRefinement.js';
import { lakeSignedDistance, resolveLakeShape, shapeLakeHeight } from './LakeShape.js';
import { sampleSnowSurfaceCpu } from './SnowDeformationField.js';

const smooth = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);
// Alpine triangles spanning more height than this get one more subdivision:
// steep faces on the alpine grid otherwise show as sawtooth crests and
// stretched facets, and the gorge walls are full of them.
const STEEP_TRIANGLE_RISE = 4.5;

export function mountainHeight(x, z) {
  const peaks = [[10, -685, 95, 95, 110], [-85, -620, 115, 120, 155], [175, -575, 125, 145, 145],
    [35, -380, 170, 140, 67], [-525, -330, 165, 210, 110], [540, -490, 165, 180, 115]];
  let height = 0;
  for (const [px, pz, sx, sz, amplitude] of peaks) {
    height += amplitude * Math.exp(-(((x - px) / sx) ** 2) - ((z - pz) / sz) ** 2);
  }
  const ridges = 1 - Math.abs(fractalNoise(x * 0.011, z * 0.011, 173, 4) * 2 - 1);
  return height * (0.7 + ridges * 0.3);
}

// Conforming subdivision: shared edges are split once, including adjacent triangles.
function refineCorridor(positions, uvs, indices, river) {
  for (let pass = 0; pass < 2; pass++) {
    const edges = new Map();
    const key = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
    for (let i = 0; i < indices.length; i += 3) {
      const ids = indices.slice(i, i + 3);
      const x = ids.reduce((s, id) => s + positions[id * 3], 0) / 3;
      const z = ids.reduce((s, id) => s + positions[id * 3 + 2], 0) / 3;
      const p = river.sample(x, z);
      if (!p || p.edge > Math.max(12, (p.bankBlend ?? 7) + 5)) continue;
      for (let e = 0; e < 3; e++) {
        const a = ids[e], b = ids[(e + 1) % 3], k = key(a, b);
        if (edges.has(k)) continue;
        edges.set(k, positions.length / 3);
        for (let c = 0; c < 3; c++) positions.push((positions[a * 3 + c] + positions[b * 3 + c]) * 0.5);
        for (let c = 0; c < 2; c++) uvs.push((uvs[a * 2 + c] + uvs[b * 2 + c]) * 0.5);
      }
    }
    const next = [];
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = indices.slice(i, i + 3);
      const ab = edges.get(key(a, b)), bc = edges.get(key(b, c)), ca = edges.get(key(c, a));
      const count = [ab, bc, ca].filter(v => v !== undefined).length;
      if (!count) next.push(a, b, c);
      else if (count === 3) next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
      else {
        // Rotate until the split pattern starts on edge a-b.
        const ids = [a, b, c], mids = [ab, bc, ca];
        while (mids[0] === undefined || (count === 2 && mids[1] === undefined)) {
          ids.push(ids.shift()); mids.push(mids.shift());
        }
        const [v0, v1, v2] = ids, [m0, m1] = mids;
        if (count === 1) next.push(v0, m0, v2, m0, v1, v2);
        else next.push(v0, m0, v2, m0, m1, v2, m0, v1, m1);
      }
    }
    indices = next;
  }
  return indices;
}

export function expandLandscape(target, original, config) {
  const settings = config.terrain.expansion;
  if (!settings?.enabled || !target?.isMesh) return null;
  const alpine = resolveAlpineConfig(config);
  const lake = resolveLakeShape(config);
  const width = settings.width ?? settings.size, depth = settings.depth ?? settings.size;
  const [centerX, centerZ] = settings.center ?? [0, 0];
  const naturalHeight = (x, z) => {
    const cx = THREE.MathUtils.clamp(x, original.bounds.min.x, original.bounds.max.x);
    const cz = THREE.MathUtils.clamp(z, original.bounds.min.z, original.bounds.max.z);
    const edgeDistance = Math.hypot(x - cx, z - cz);
    const old = original.sampleHeight(cx, cz);
    const outer = 14 + fractalNoise(x * 0.007, z * 0.007, 64, 4) * 24;
    const base = THREE.MathUtils.lerp(old, outer, smooth(0, 170, edgeDistance));
    const mountain = base + mountainHeight(x, z) * smooth(210, 325, -z);
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
    ? new RiverCourse(config.water.river, baseHeight, config.water.position[1]) : null;
  paths.createTexture();
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
      shouldRefine: (x, z) => alpineDistance(x, z, alpine) <= alpine.refineRadius,
      sampleHeight: baseHeight,
    });
    refined = refineTerrainRegion({
      positions,
      uvs,
      indices: refined,
      passes: 1,
      shouldRefine: (x, z, ids) => {
        if (alpineDistance(x, z, alpine) > alpine.refineRadius) return false;
        let low = Infinity, high = -Infinity;
        for (const id of ids) {
          low = Math.min(low, positions[id * 3 + 1]);
          high = Math.max(high, positions[id * 3 + 1]);
        }
        return high - low > STEEP_TRIANGLE_RISE;
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
      shouldRefine: (x, z) => Math.abs(lakeSignedDistance(x, z, lake)) <= 12,
      sampleHeight: baseHeight,
    });
  }
  if (river) refined = refineCorridor(positions, uvs, refined, river);
  if (river) for (let i = 0; i < positions.length; i += 3) {
    positions[i + 1] = river.carve(positions[i], positions[i + 2], positions[i + 1]);
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
  const previous = target.geometry;
  target.geometry = geometry;
  river?.createTexture();
  return { river, paths, original, baseHeight, naturalHeight, alpine, dispose() { target.geometry = previous; geometry.dispose(); river?.dispose(); paths.dispose(); original.texture?.dispose(); } };
}

export function adaptLandscapeRecords(trees, props, expansion, terrain) {
  if (!expansion) return { trees, props };
  const { original, river, alpine } = expansion;
  const rebase = records => (records ?? []).filter(p => !river || (river.sample(p[0], p[2])?.edge ?? 100) > 5)
    .map(p => {
      const record = [...p];
      record[1] += terrain.sampleHeight(p[0], p[2]) - original.sampleHeight(p[0], p[2]);
      return record;
    });
  const snowAt = (x, z) => sampleSnowSurfaceCpu(terrain, x, z, 2, terrain.config)?.coverage ?? 0;
  const allowed = (x, y, z) => alpineTreeAllowed(x, y, z, alpine, snowAt(x, z));
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
  return { trees: result.filter(outsideJungle), props: { stones: rebase(props.stones),
    lanterns: createPathLanternPairs(rebase(props.lanterns), expansion.paths, terrain, river) } };
}
