import * as THREE from 'three';

const SKIRT = 0.75;
const SEGMENT_LENGTH = 2;

/** Build a closed ribbon on the inner faces of four axis-aligned collider boxes. */
export function createBoundaryGeometry(records, sampler, { height = 12 } = {}) {
  if (!Array.isArray(records) || records.length !== 4 || !sampler?.ready
    || !Number.isFinite(height) || height <= 0 || height > 100) {
    throw new Error('Barrier requires four boundary walls, ready terrain, and a positive height <= 100.');
  }
  const xWalls = [], zWalls = [];
  for (const { position, size } of records) {
    if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)
      || !Array.isArray(size) || size.length !== 3 || !size.every(v => Number.isFinite(v) && v > 0)) {
      throw new Error('Invalid boundary collider dimensions.');
    }
    (size[0] < size[2] ? xWalls : zWalls).push({ position, size });
  }
  if (xWalls.length !== 2 || zWalls.length !== 2) throw new Error('Boundary walls must enclose a rectangle.');
  xWalls.sort((a, b) => a.position[0] - b.position[0]);
  zWalls.sort((a, b) => a.position[2] - b.position[2]);
  const west = xWalls[0].position[0] + xWalls[0].size[0] / 2;
  const east = xWalls[1].position[0] - xWalls[1].size[0] / 2;
  const north = zWalls[0].position[2] + zWalls[0].size[2] / 2;
  const south = zWalls[1].position[2] - zWalls[1].size[2] / 2;
  // Authored collider lengths differ slightly. Intersect the inner face lines
  // to close the visual corners rather than reproducing gaps or overhangs.
  if (east <= west || south <= north) {
    throw new Error('Boundary collider faces do not enclose a positive area.');
  }
  const perimeter = 2 * (east - west + south - north);
  if (perimeter > 100000) throw new Error('Boundary perimeter exceeds the geometry budget.');
  const corners = [[west, north], [east, north], [east, south], [west, south], [west, north]];
  const positions = [], uvs = [], indices = [];
  let distance = 0;
  const addColumn = (x, z, u) => {
    const ground = sampler.sampleHeight(x, z);
    if (!Number.isFinite(ground)) throw new Error('Boundary terrain height is not finite.');
    positions.push(x, ground - SKIRT, z, x, ground + height, z);
    uvs.push(u, 0, u, 1);
  };
  for (let side = 0; side < 4; side++) {
    const [x0, z0] = corners[side], [x1, z1] = corners[side + 1];
    const length = Math.hypot(x1 - x0, z1 - z0);
    const count = Math.ceil(length / SEGMENT_LENGTH);
    for (let i = 0; i < count; i++) {
      const t = i / count;
      addColumn(THREE.MathUtils.lerp(x0, x1, t), THREE.MathUtils.lerp(z0, z1, t), (distance + length * t) / perimeter);
    }
    distance += length;
  }
  addColumn(west, north, 1);
  const columns = positions.length / 6;
  for (let i = 0; i < columns - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // The duplicated UV seam must share its normal as well as its position.
  const normal = geometry.attributes.normal;
  for (let row = 0; row < 2; row++) {
    const last = normal.count - 2 + row;
    const joined = new THREE.Vector3().fromBufferAttribute(normal, row)
      .add(new THREE.Vector3().fromBufferAttribute(normal, last)).normalize();
    normal.setXYZ(row, joined.x, joined.y, joined.z);
    normal.setXYZ(last, joined.x, joined.y, joined.z);
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData = { perimeter, height, skirt: SKIRT };
  return geometry;
}
