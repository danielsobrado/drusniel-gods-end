import * as THREE from 'three';

// Project triangles onto the height grid once. Casting one ray per grid point
// against every terrain triangle makes loading scale as grid size × mesh size.
export async function rasterizeTerrain(root, bounds, resolution, onProgress = () => {}) {
  const heights = new Float32Array(resolution * resolution);
  heights.fill(bounds.min.y);
  const size = bounds.getSize(new THREE.Vector3());
  const meshes = [];
  root.traverse(object => { if (object.isMesh && object.geometry?.attributes.position) meshes.push(object); });
  const point = new THREE.Vector3();
  let processed = 0;
  const total = meshes.reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3, 0);
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const positions = geometry.attributes.position;
    const transformed = new Float64Array(positions.count * 3);
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < positions.count; i++) {
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
      const ax = transformed[a], az = transformed[a + 2];
      const bx = transformed[b], bz = transformed[b + 2];
      const cx = transformed[c], cz = transformed[c + 2];
      const determinant = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      const material = Array.isArray(mesh.material)
        ? mesh.material[geometry.groups.find(group => i >= group.start && i < group.start + group.count)?.materialIndex ?? 0]
        : mesh.material;
      const side = material?.side ?? THREE.FrontSide;
      if (Math.abs(determinant) > 1e-12 && !(side === THREE.FrontSide && determinant > 0) && !(side === THREE.BackSide && determinant < 0)) {
        const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 1e-7));
        const maxX = Math.min(resolution - 1, Math.floor(Math.max(ax, bx, cx) + 1e-7));
        const minZ = Math.max(0, Math.ceil(Math.min(az, bz, cz) - 1e-7));
        const maxZ = Math.min(resolution - 1, Math.floor(Math.max(az, bz, cz) + 1e-7));
        for (let z = minZ; z <= maxZ; z++) {
          for (let x = minX; x <= maxX; x++) {
            const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / determinant;
            const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / determinant;
            const wc = 1 - wa - wb;
            if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) continue;
            const y = wa * transformed[a + 1] + wb * transformed[b + 1] + wc * transformed[c + 1];
            const index = z * resolution + x;
            heights[index] = Math.max(heights[index], y);
          }
        }
      }
      processed++;
      if (processed % 20000 === 0) {
        onProgress(processed / Math.max(total, 1));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }
  onProgress(1);
  return heights;
}
