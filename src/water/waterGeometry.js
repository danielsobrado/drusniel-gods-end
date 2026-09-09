import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSeaGeometry } from './seaGeometry.js';
import { seaDisplacementBound } from './seaWaves.js';

export function createWaterGeometry(params, river) {
  const lake = new THREE.PlaneGeometry(params.size, params.size, params.segments, params.segments);
  lake.rotateX(-Math.PI / 2);
  lake.translate(...params.position);
  const count = lake.attributes.position.count;
  lake.deleteAttribute('uv'); lake.deleteAttribute('normal');
  lake.setAttribute('waterKind', new THREE.Float32BufferAttribute(new Float32Array(count), 1));
  lake.setAttribute('waterLevel', new THREE.Float32BufferAttribute(new Float32Array(count).fill(params.position[1]), 1));
  lake.setAttribute('waterFlow', new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  lake.setAttribute('riverSurface', new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  let geometry = lake;
  if (river) {
    const positions = [], kinds = [], levels = [], flows = [], surfaces = [], indices = [];
    const samples = [...river.samples];
    const first = samples[0], last = samples.at(-1);
    samples.unshift({ ...first, x: first.x - first.dx * first.width, z: first.z - first.dz * first.width });
    samples.push({ ...last, x: last.x + last.dx * last.width, z: last.z + last.dz * last.width });
    const columns = 16;
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i], next = samples[Math.min(i + 1, samples.length - 1)];
      const slope = Math.max(0, (p.y - next.y) / Math.max(1, next.s - p.s));
      const mouth = THREE.MathUtils.smoothstep(p.y - river.lakeLevel, 0, 2);
      const speed = (0.9 + Math.min(2.8, slope * 7)) * mouth + 0.18;
      for (let j = 0; j <= columns; j++) {
        const across = (j / columns * 2 - 1) * (p.width / 2 + 2);
        const relief = THREE.MathUtils.smoothstep(p.slope ?? slope, 0.2, 0.8)
          * Math.sin(across * 1.3 + p.s * 0.27) * 0.14;
        positions.push(p.x - p.dz * across, p.y + relief, p.z + p.dx * across);
        kinds.push(1); levels.push(p.y); flows.push(p.dx, p.dz, speed, p.s);
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
    ribbon.setIndex(indices);
    geometry = mergeGeometries([lake, ribbon]);
    lake.dispose(); ribbon.dispose();
  }
  if (params.sea?.enabled) {
    const ocean = createSeaGeometry(params.sea);
    const merged = mergeGeometries([geometry, ocean]);
    geometry.dispose(); ocean.dispose(); geometry = merged;
  }
  geometry.translate(-params.position[0], -params.position[1], -params.position[2]);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const displacement = Math.max(1.5, params.sea?.enabled ? seaDisplacementBound(params.sea) : 0);
  geometry.boundingBox.min.y -= displacement;
  geometry.boundingBox.max.y += displacement;
  geometry.boundingSphere.radius += displacement;
  return geometry;
}
