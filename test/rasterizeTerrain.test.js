import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { rasterizeTerrain } from '../src/world/rasterizeTerrain.js';

test('terrain rasterization preserves a planar height field across shared triangles', async () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -1, 0, -1,
    1, 2, -1,
    -1, 3, 1,
    1, 5, 1,
  ], 3));
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const terrain = new THREE.Mesh(geometry, material);
  terrain.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(terrain);

  try {
    const resolution = 5;
    const heights = await rasterizeTerrain(terrain, bounds, resolution);
    for (let z = 0; z < resolution; z += 1) {
      const worldZ = THREE.MathUtils.lerp(-1, 1, z / (resolution - 1));
      for (let x = 0; x < resolution; x += 1) {
        const worldX = THREE.MathUtils.lerp(-1, 1, x / (resolution - 1));
        const expected = worldX + worldZ * 1.5 + 2.5;
        assert.ok(
          Math.abs(heights[z * resolution + x] - expected) < 1e-6,
          `height at ${x},${z}`,
        );
      }
    }
  } finally {
    geometry.dispose();
    material.dispose();
  }
});


async function referenceRasterizeTerrain(root, bounds, resolution) {
  const heights = new Float32Array(resolution * resolution);
  heights.fill(bounds.min.y);
  const size = bounds.getSize(new THREE.Vector3());
  const point = new THREE.Vector3();
  const meshes = [];
  root.traverse(object => {
    if (object.isMesh && object.geometry?.attributes?.position) meshes.push(object);
  });

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const positions = geometry.attributes.position;
    const transformed = new Float64Array(positions.count * 3);
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < positions.count; i += 1) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      transformed[i * 3] = (point.x - bounds.min.x) / size.x * (resolution - 1);
      transformed[i * 3 + 1] = point.y;
      transformed[i * 3 + 2] = (point.z - bounds.min.z) / size.z * (resolution - 1);
    }

    const count = geometry.index?.count ?? positions.count;
    const start = Math.max(0, geometry.drawRange.start);
    const end = Math.min(count, start + geometry.drawRange.count);
    for (let i = start; i < end; i += 3) {
      const a = (geometry.index ? geometry.index.getX(i) : i) * 3;
      const b = (geometry.index ? geometry.index.getX(i + 1) : i + 1) * 3;
      const c = (geometry.index ? geometry.index.getX(i + 2) : i + 2) * 3;
      const ax = transformed[a], ay = transformed[a + 1], az = transformed[a + 2];
      const bx = transformed[b], by = transformed[b + 1], bz = transformed[b + 2];
      const cx = transformed[c], cy = transformed[c + 1], cz = transformed[c + 2];
      const determinant = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      const material = Array.isArray(mesh.material)
        ? mesh.material[geometry.groups.find(group => i >= group.start && i < group.start + group.count)?.materialIndex ?? 0]
        : mesh.material;
      const side = material?.side ?? THREE.FrontSide;
      if (Math.abs(determinant) <= 1e-12
        || (side === THREE.FrontSide && determinant > 0)
        || (side === THREE.BackSide && determinant < 0)) continue;

      const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 1e-7));
      const maxX = Math.min(resolution - 1, Math.floor(Math.max(ax, bx, cx) + 1e-7));
      const minZ = Math.max(0, Math.ceil(Math.min(az, bz, cz) - 1e-7));
      const maxZ = Math.min(resolution - 1, Math.floor(Math.max(az, bz, cz) + 1e-7));
      for (let z = minZ; z <= maxZ; z += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / determinant;
          const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / determinant;
          const wc = 1 - wa - wb;
          if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) continue;
          const y = wa * ay + wb * by + wc * cy;
          const index = z * resolution + x;
          heights[index] = Math.max(heights[index], y);
        }
      }
    }
  }
  return heights;
}

test('incremental terrain rasterization is byte-exact with direct barycentric evaluation', async () => {
  const root = new THREE.Group();
  const materials = [
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
  ];

  const base = new THREE.BufferGeometry();
  base.setAttribute('position', new THREE.Float32BufferAttribute([
    -2.0, 0.0, -1.5,
     1.7, 1.1, -1.2,
    -1.4, 2.8,  1.6,
     2.2, 4.3,  1.8,
  ], 3));
  base.setIndex([0, 2, 1, 1, 2, 3]);
  base.clearGroups();
  base.addGroup(0, 3, 0);
  base.addGroup(3, 3, 1);
  const mesh = new THREE.Mesh(base, materials);
  mesh.position.set(0.35, 1.25, -0.4);
  mesh.rotation.set(0.08, 0.21, -0.04);
  mesh.scale.set(1.15, 0.9, 1.05);
  root.add(mesh);

  const overlayGeometry = new THREE.BufferGeometry();
  overlayGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -1.3, 3.0, -0.9,
     1.2, 3.6, -0.7,
    -0.8, 4.1,  1.0,
     1.5, 4.8,  1.1,
  ], 3));
  overlayGeometry.setIndex([0, 2, 1, 1, 2, 3]);
  overlayGeometry.setDrawRange(0, 3);
  const overlayMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const overlay = new THREE.Mesh(overlayGeometry, overlayMaterial);
  overlay.position.set(-0.2, 0.4, 0.3);
  root.add(overlay);

  root.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(root);
  const resolution = 37;

  try {
    const expected = await referenceRasterizeTerrain(root, bounds, resolution);
    const actual = await rasterizeTerrain(root, bounds, resolution);
    assert.deepEqual(
      new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength),
      new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength),
    );
  } finally {
    base.dispose();
    overlayGeometry.dispose();
    materials.forEach(material => material.dispose());
    overlayMaterial.dispose();
  }
});
