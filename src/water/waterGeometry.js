import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lakeSignedDistance } from '../world/LakeShape.js';

const MIN_RIVER_SPEED = 0.18;
const OUTLET_BASE_SPEED = 0.7;
const OUTLET_SPEED_GAIN = 0.65;
const OUTLET_TAIL_DISTANCE = 2;

// Partition existing triangles, including their original normals, rather than
// rebuilding surfaces at cell edges. This only changes visibility granularity.
export function partitionWaterGeometry(geometry, cellSize = 128) {
  const cells = new Map();
  const position = geometry.attributes.position;
  const level = geometry.attributes.waterLevel;
  const kind = geometry.attributes.waterKind;
  const index = geometry.index;
  for (let i = 0; i < index.count; i += 3) {
    const vertices = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    const x = vertices.reduce((sum, v) => sum + position.getX(v), 0) / 3;
    const z = vertices.reduce((sum, v) => sum + position.getZ(v), 0) / 3;
    // Keep the lake and ribbon separate, including where they overlap.
    const key = `${kind.getX(vertices[0])}:${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`;
    if (!cells.has(key)) cells.set(key, { vertices: [], indices: [], mapping: new Map() });
    const cell = cells.get(key);
    for (const vertex of vertices) {
      if (!cell.mapping.has(vertex)) {
        cell.mapping.set(vertex, cell.vertices.length);
        cell.vertices.push(vertex);
      }
      cell.indices.push(cell.mapping.get(vertex));
    }
  }
  return [...cells.values()].map(cell => {
    const chunk = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      const data = new attribute.array.constructor(cell.vertices.length * attribute.itemSize);
      cell.vertices.forEach((vertex, i) => {
        for (let c = 0; c < attribute.itemSize; c += 1) {
          data[i * attribute.itemSize + c] = attribute.array[vertex * attribute.itemSize + c];
        }
      });
      chunk.setAttribute(name, new THREE.BufferAttribute(data, attribute.itemSize, attribute.normalized));
    }
    chunk.setIndex(cell.indices);
    chunk.userData.waterLevelMin = Math.min(...cell.vertices.map(v => level.getX(v)));
    chunk.userData.waterLevelMax = Math.max(...cell.vertices.map(v => level.getX(v)));
    chunk.computeBoundingBox();
    chunk.computeBoundingSphere();
    chunk.boundingBox.min.y -= 1.5;
    chunk.boundingBox.max.y += 1.5;
    chunk.boundingSphere.radius += 1.5;
    return chunk;
  });
}

// A grid over the lake's outline that keeps only the cells reaching within
// lake.margin of its shore. The margin runs under the banks, so the surface
// ends inside the ground instead of at the edge of a square seen side-on.
// Beyond the shore the river channel is the ribbon's, so the lake stops there.
export function createShorelineGeometry(lake, river = null, cellSize = 4) {
  const { minX, minZ, maxX, maxZ } = lake.bounds;
  const columns = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
  const distances = new Float32Array((columns + 1) * (rows + 1));
  for (let j = 0; j <= rows; j += 1) for (let i = 0; i <= columns; i += 1) {
    distances[j * (columns + 1) + i] = lakeSignedDistance(minX + i * cellSize, minZ + j * cellSize, lake);
  }
  const positions = [], indices = [], remap = new Map();
  const vertex = (i, j) => {
    const key = j * (columns + 1) + i;
    if (!remap.has(key)) {
      remap.set(key, positions.length / 3);
      positions.push(minX + i * cellSize, lake.level, minZ + j * cellSize);
    }
    return remap.get(key);
  };
  for (let j = 0; j < rows; j += 1) for (let i = 0; i < columns; i += 1) {
    const corners = [j * (columns + 1) + i, j * (columns + 1) + i + 1, (j + 1) * (columns + 1) + i, (j + 1) * (columns + 1) + i + 1];
    if (Math.min(...corners.map(k => distances[k])) > lake.margin) continue;
    const cx = minX + (i + 0.5) * cellSize, cz = minZ + (j + 0.5) * cellSize;
    if (river && distances[corners[0]] > 0 && distances[corners[3]] > 0 && river.sample(cx, cz)?.edge < 2) continue;
    const a = vertex(i, j), b = vertex(i + 1, j), c = vertex(i, j + 1), d = vertex(i + 1, j + 1);
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

export function createWaterGeometry(params, river, shape = null) {
  let lake;
  if (shape) {
    lake = createShorelineGeometry(shape, river);
  } else {
    lake = new THREE.PlaneGeometry(params.size, params.size, params.segments, params.segments);
    lake.rotateX(-Math.PI / 2);
    lake.translate(...params.position);
  }
  const count = lake.attributes.position.count;
  lake.deleteAttribute('uv');
  lake.deleteAttribute('normal');
  lake.setAttribute('waterKind', new THREE.Float32BufferAttribute(new Float32Array(count), 1));
  lake.setAttribute('waterLevel', new THREE.Float32BufferAttribute(new Float32Array(count).fill(params.position[1]), 1));
  lake.setAttribute('waterFlow', new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  lake.setAttribute('riverSurface', new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  // 1 where the lake's surface lies, so the river ribbon gives way to it there.
  lake.setAttribute('lakeMask', new THREE.Float32BufferAttribute(new Float32Array(count).fill(1), 1));

  let geometry = lake;
  if (river) {
    const positions = [], kinds = [], levels = [], flows = [], surfaces = [], masks = [], indices = [];
    const half = params.size / 2;
    const inLake = shape
      ? (x, z) => lakeSignedDistance(x, z, shape) < 0
      : (x, z) => Math.abs(x - params.position[0]) < half && Math.abs(z - params.position[2]) < half;
    const samples = [...river.samples];
    const first = samples[0], last = samples.at(-1);
    samples.unshift({ ...first, x: first.x - first.dx * first.width, z: first.z - first.dz * first.width });
    const tailDistance = (last.outletProgress ?? 0) > 0 ? OUTLET_TAIL_DISTANCE : last.width;
    samples.push({ ...last, x: last.x + last.dx * tailDistance, z: last.z + last.dz * tailDistance });
    const columns = 16;
    for (let i = 0; i < samples.length; i += 1) {
      const p = samples[i], next = samples[Math.min(i + 1, samples.length - 1)];
      const slope = Math.max(0, (p.y - next.y) / Math.max(1, next.s - p.s));
      const outletProgress = p.outletProgress ?? 0;
      const inletStrength = THREE.MathUtils.smoothstep(p.y - river.lakeLevel, 0, 2);
      const inletSpeed = (0.9 + Math.min(2.8, slope * 7)) * inletStrength + MIN_RIVER_SPEED;
      const outletSpeed = OUTLET_BASE_SPEED + Math.min(1.4, slope * 12) + outletProgress * OUTLET_SPEED_GAIN;
      const speed = THREE.MathUtils.lerp(inletSpeed, outletSpeed, outletProgress);
      for (let j = 0; j <= columns; j += 1) {
        const across = (j / columns * 2 - 1) * (p.width / 2 + 2);
        const relief = THREE.MathUtils.smoothstep(p.slope ?? slope, 0.2, 0.8)
          * Math.sin(across * 1.3 + p.s * 0.27) * 0.14;
        positions.push(p.x - p.dz * across, p.y + relief, p.z + p.dx * across);
        masks.push(inLake(p.x - p.dz * across, p.z + p.dx * across) ? 1 : 0);
        kinds.push(1);
        levels.push(p.y);
        flows.push(p.dx, p.dz, speed, p.s);
        surfaces.push(across, p.surfaceDistance ?? p.s, p.slope ?? slope, p.impact ?? 0);
        if (i < samples.length - 1 && j < columns) {
          const a = i * (columns + 1) + j, b = a + 1, c = a + columns + 1, d = c + 1;
          indices.push(a, b, c, b, d, c);
        }
      }
    }
    const ribbon = new THREE.BufferGeometry();
    ribbon.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    ribbon.setAttribute('waterKind', new THREE.Float32BufferAttribute(kinds, 1));
    ribbon.setAttribute('waterLevel', new THREE.Float32BufferAttribute(levels, 1));
    ribbon.setAttribute('waterFlow', new THREE.Float32BufferAttribute(flows, 4));
    ribbon.setAttribute('riverSurface', new THREE.Float32BufferAttribute(surfaces, 4));
    ribbon.setAttribute('lakeMask', new THREE.Float32BufferAttribute(masks, 1));
    ribbon.setIndex(indices);
    geometry = mergeGeometries([lake, ribbon]);
    lake.dispose();
    ribbon.dispose();
  }

  geometry.translate(-params.position[0], -params.position[1], -params.position[2]);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.boundingBox.min.y -= 1.5;
  geometry.boundingBox.max.y += 1.5;
  geometry.boundingSphere.radius += 1.5;
  return geometry;
}
