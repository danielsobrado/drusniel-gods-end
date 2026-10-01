import * as THREE from 'three';
import { coastX, resolveCoastConfig } from '../world/CoastField.js';
import { seaDisplacementBound } from './seaWaves.js';

export const SEA_ACROSS_BOUNDS = Object.freeze([-180, 80, 180, 650, 1100, 2000, 4500]);
export const SEA_ALONG_BOUNDS = Object.freeze([-3000, -1200, -850, -425, 0, 425, 850, 1200, 3000]);

const QUALITY_SPACING = Object.freeze({
  performance: Object.freeze({
    surf: 2, inner: 4, outer: 8, far: [20, 60, 180],
    along: { central: 8, shoulder: 24, distant: 90 },
  }),
  balanced: Object.freeze({
    surf: 1, inner: 3, outer: 6, far: [15, 45, 120],
    along: { central: 6, shoulder: 14, distant: 60 },
  }),
  high: Object.freeze({
    surf: 1, inner: 2, outer: 4, far: [10, 30, 90],
    along: { central: 4, shoulder: 10, distant: 45 },
  }),
  ultra: Object.freeze({
    surf: 1, inner: 2, outer: 2, far: [8, 24, 72],
    along: { central: 4, shoulder: 8, distant: 45 },
  }),
});

function axis(start, end, spacing) {
  const intervals = Math.max(1, Math.ceil((end - start) / spacing));
  const result = new Array(intervals + 1);
  for (let i = 0; i <= intervals; i += 1) {
    result[i] = i === intervals ? end : start + (end - start) * i / intervals;
  }
  return result;
}

function acrossAxis(index, quality) {
  const spacing = QUALITY_SPACING[quality] ?? QUALITY_SPACING.high;
  const start = SEA_ACROSS_BOUNDS[index], end = SEA_ACROSS_BOUNDS[index + 1];
  if (index === 0) {
    return [
      ...axis(start, -10, 10).slice(0, -1),
      ...axis(-10, end, spacing.surf),
    ];
  }
  if (index === 1) return axis(start, end, spacing.inner);
  if (index === 2) return axis(start, end, spacing.outer);
  return axis(start, end, spacing.far[index - 3]);
}

function alongAxis(index, quality) {
  const spacing = QUALITY_SPACING[quality] ?? QUALITY_SPACING.high;
  const start = SEA_ALONG_BOUNDS[index], end = SEA_ALONG_BOUNDS[index + 1];
  const maximum = Math.max(Math.abs(start), Math.abs(end));
  const band = maximum <= 850 ? 'central' : maximum <= 1200 ? 'shoulder' : 'distant';
  return axis(start, end, spacing.along[band]);
}

function createTileGeometry(sea, across, along, rootPosition, displacement) {
  const width = across.length;
  const height = along.length;
  const count = width * height;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const kinds = new Float32Array(count).fill(2);
  const levels = new Float32Array(count).fill(sea.level);
  const flows = new Float32Array(count * 4);
  const surfaces = new Float32Array(count * 4);
  let cursor = 0;
  for (const z of along) {
    const shore = coastX(z, sea);
    for (const distance of across) {
      positions[cursor * 3] = shore + distance - rootPosition[0];
      positions[cursor * 3 + 1] = sea.level - rootPosition[1];
      positions[cursor * 3 + 2] = z - rootPosition[2];
      normals[cursor * 3 + 1] = 1;
      cursor += 1;
    }
  }

  const indices = [];
  for (let z = 0; z < height - 1; z += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const a = z * width + x;
      const b = a + 1;
      const c = a + width;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('waterKind', new THREE.BufferAttribute(kinds, 1));
  geometry.setAttribute('waterLevel', new THREE.BufferAttribute(levels, 1));
  geometry.setAttribute('waterFlow', new THREE.BufferAttribute(flows, 4));
  geometry.setAttribute('riverSurface', new THREE.BufferAttribute(surfaces, 4));
  // Signed distance to the lake outline (waterGeometry): the sea is never in it.
  geometry.setAttribute('lakeMask', new THREE.BufferAttribute(new Float32Array(count).fill(64), 1));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.boundingBox.min.y -= displacement;
  geometry.boundingBox.max.y += displacement;
  geometry.boundingSphere.radius += displacement;
  return geometry;
}

export function createSeaTileGeometries(seaConfig, quality = 'high', rootPosition = [0, 0, 0]) {
  const sea = resolveCoastConfig(seaConfig);
  const displacement = seaDisplacementBound(sea);
  const tiles = [];
  for (let acrossIndex = 0; acrossIndex < SEA_ACROSS_BOUNDS.length - 1; acrossIndex += 1) {
    const across = acrossAxis(acrossIndex, quality);
    for (let alongIndex = 0; alongIndex < SEA_ALONG_BOUNDS.length - 1; alongIndex += 1) {
      const along = alongAxis(alongIndex, quality);
      const geometry = createTileGeometry(sea, across, along, rootPosition, displacement);
      tiles.push({
        geometry,
        acrossIndex,
        alongIndex,
        distanceRange: [SEA_ACROSS_BOUNDS[acrossIndex], SEA_ACROSS_BOUNDS[acrossIndex + 1]],
        zRange: [SEA_ALONG_BOUNDS[alongIndex], SEA_ALONG_BOUNDS[alongIndex + 1]],
        columns: across.length,
        rows: along.length,
      });
    }
  }
  return tiles;
}

export function seaTileStats(tiles) {
  return tiles.reduce((stats, tile) => {
    const geometry = tile.geometry ?? tile;
    stats.tiles += 1;
    stats.vertices += geometry.attributes.position.count;
    stats.triangles += geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
    return stats;
  }, { tiles: 0, vertices: 0, triangles: 0 });
}
