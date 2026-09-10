import * as THREE from 'three';

export const TERRAIN_NORMAL_STEP = 0.8;

export function sampleHeightGrid(heights, resolution, u, v) {
  const px = Math.min(1, Math.max(0, u)) * (resolution - 1);
  const py = Math.min(1, Math.max(0, v)) * (resolution - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(resolution - 1, x0 + 1);
  const y1 = Math.min(resolution - 1, y0 + 1);
  const tx = px - x0;
  const ty = py - y0;
  const h00 = heights[y0 * resolution + x0];
  const h10 = heights[y0 * resolution + x1];
  const h01 = heights[y1 * resolution + x0];
  const h11 = heights[y1 * resolution + x1];
  return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty;
}

/** Same central-difference slope as the cinematic grass 4-tap height sample. */
export function terrainNormalAtUv(heights, resolution, size, u, v) {
  const du = TERRAIN_NORMAL_STEP / Math.max(size.x, 1e-6);
  const dv = TERRAIN_NORMAL_STEP / Math.max(size.z, 1e-6);
  const nx = sampleHeightGrid(heights, resolution, u - du, v) - sampleHeightGrid(heights, resolution, u + du, v);
  const ny = TERRAIN_NORMAL_STEP * 2;
  const nz = sampleHeightGrid(heights, resolution, u, v - dv) - sampleHeightGrid(heights, resolution, u, v + dv);
  const length = Math.hypot(nx, ny, nz) || 1;
  return [nx / length, ny / length, nz / length];
}

export function encodeTerrainNormal(nx, ny, nz) {
  return [
    Math.round((nx * 0.5 + 0.5) * 255),
    Math.round((ny * 0.5 + 0.5) * 255),
    Math.round((nz * 0.5 + 0.5) * 255),
  ];
}

export function createTerrainNormalDataTexture(heights, resolution, size) {
  const data = new Uint8Array(resolution * resolution * 4);
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const u = resolution === 1 ? 0 : x / (resolution - 1);
      const v = resolution === 1 ? 0 : y / (resolution - 1);
      const [nx, ny, nz] = terrainNormalAtUv(heights, resolution, size, u, v);
      const [r, g, b] = encodeTerrainNormal(nx, ny, nz);
      const index = (y * resolution + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, resolution, resolution, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}
