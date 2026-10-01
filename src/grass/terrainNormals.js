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

function prepareAxisSamples(resolution, offset) {
  const lower = new Int32Array(resolution);
  const upper = new Int32Array(resolution);
  const blend = new Float64Array(resolution);
  const scale = resolution - 1;
  for (let index = 0; index < resolution; index += 1) {
    const uv = resolution === 1 ? 0 : index / scale;
    const position = Math.min(1, Math.max(0, uv + offset)) * scale;
    const low = Math.floor(position);
    lower[index] = low;
    upper[index] = Math.min(resolution - 1, low + 1);
    blend[index] = position - low;
  }
  return { lower, upper, blend };
}

function samplePrepared(heights, resolution, x0, x1, tx, y0, y1, ty) {
  const h00 = heights[y0 * resolution + x0];
  const h10 = heights[y0 * resolution + x1];
  const h01 = heights[y1 * resolution + x0];
  const h11 = heights[y1 * resolution + x1];
  return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty)
    + h01 * (1 - tx) * ty + h11 * tx * ty;
}

export function createTerrainNormalTexture(data, resolution) {
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

export function createTerrainNormalDataTexture(heights, resolution, size) {
  const data = new Uint8Array(resolution * resolution * 4);
  const du = TERRAIN_NORMAL_STEP / Math.max(size.x, 1e-6);
  const dv = TERRAIN_NORMAL_STEP / Math.max(size.z, 1e-6);
  const xBase = prepareAxisSamples(resolution, 0);
  const xLeft = prepareAxisSamples(resolution, -du);
  const xRight = prepareAxisSamples(resolution, du);
  const yBase = prepareAxisSamples(resolution, 0);
  const yDown = prepareAxisSamples(resolution, -dv);
  const yUp = prepareAxisSamples(resolution, dv);
  const ny = TERRAIN_NORMAL_STEP * 2;

  for (let y = 0; y < resolution; y += 1) {
    const baseY0 = yBase.lower[y];
    const baseY1 = yBase.upper[y];
    const baseTy = yBase.blend[y];
    const downY0 = yDown.lower[y];
    const downY1 = yDown.upper[y];
    const downTy = yDown.blend[y];
    const upY0 = yUp.lower[y];
    const upY1 = yUp.upper[y];
    const upTy = yUp.blend[y];

    for (let x = 0; x < resolution; x += 1) {
      const baseX0 = xBase.lower[x];
      const baseX1 = xBase.upper[x];
      const baseTx = xBase.blend[x];
      const left = samplePrepared(
        heights, resolution,
        xLeft.lower[x], xLeft.upper[x], xLeft.blend[x],
        baseY0, baseY1, baseTy,
      );
      const right = samplePrepared(
        heights, resolution,
        xRight.lower[x], xRight.upper[x], xRight.blend[x],
        baseY0, baseY1, baseTy,
      );
      const down = samplePrepared(
        heights, resolution,
        baseX0, baseX1, baseTx,
        downY0, downY1, downTy,
      );
      const up = samplePrepared(
        heights, resolution,
        baseX0, baseX1, baseTx,
        upY0, upY1, upTy,
      );
      const nx = left - right;
      const nz = down - up;
      const length = Math.hypot(nx, ny, nz) || 1;
      const index = (y * resolution + x) * 4;
      data[index] = Math.round((nx / length * 0.5 + 0.5) * 255);
      data[index + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
      data[index + 2] = Math.round((nz / length * 0.5 + 0.5) * 255);
      data[index + 3] = 255;
    }
  }

  return createTerrainNormalTexture(data, resolution);
}
