import * as THREE from 'three';
import { coastX } from '../world/coast.js';

function gradedAxis(start, ranges) {
  const values = [start];
  for (const [end, step] of ranges) {
    const from = values.at(-1), count = Math.ceil((end - from) / step);
    for (let i = 1; i <= count; i++) values.push(from + (end - from) * i / count);
  }
  return values;
}

export function createSeaGeometry(sea) {
  // One indexed grid, so there are no independent strip edges to crack. Across
  // the shore: 1 m surf, 2 m playable sea, then increasingly sparse horizon.
  const across = gradedAxis(-180, [[-10, 10], [80, 1], [650, 2], [1100, 10], [2000, 30], [4500, 90]]);
  const along = gradedAxis(-3000, [[-1200, 60], [-850, 14], [850, 4], [1200, 14], [3000, 60]]);
  const columns = across.length, rows = along.length, count = columns * rows;
  const positions = new Float32Array(count * 3), indices = new Uint32Array((columns - 1) * (rows - 1) * 6);
  let k = 0;
  for (let j = 0; j < rows; j++) {
    const z = along[j], shore = coastX(z, sea.shoreX);
    for (let i = 0; i < columns; i++) {
      const vertex = j * columns + i;
      positions.set([shore + across[i], sea.level, z], vertex * 3);
      if (i < columns - 1 && j < rows - 1) {
        const a = vertex, b = a + 1, c = a + columns, d = c + 1;
        indices.set([a, c, b, b, c, d], k); k += 6;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('waterKind', new THREE.Float32BufferAttribute(new Float32Array(count).fill(2), 1));
  geometry.setAttribute('waterLevel', new THREE.Float32BufferAttribute(new Float32Array(count).fill(sea.level), 1));
  geometry.setAttribute('waterFlow', new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  geometry.setAttribute('riverSurface', new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}
