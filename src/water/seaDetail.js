import * as THREE from 'three';

export const SEA_DETAIL_SLOPE_RANGE = 4;
export const SEA_DETAIL_MOMENT_SCALE = 2 * SEA_DETAIL_SLOPE_RANGE * SEA_DETAIL_SLOPE_RANGE;

export function createSeaDetailTexture(choppiness = 4) {
  const size = 512;
  const heights = new Float32Array(size * size);
  const data = new Uint8Array(size * size * 4);
  const noise = (x, y, cells) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const hash = (a, b) => {
      const n = Math.sin(((a % cells + cells) % cells) * 127.1
        + ((b % cells + cells) % cells) * 311.7) * 43758.5453;
      return n - Math.floor(n);
    };
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), sx),
      THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), sx),
      sy,
    ) * 2 - 1;
  };
  const octave = (u, v, warp, choppy) => {
    const a = u + warp, b = v + warp;
    const x = 1 - Math.abs(Math.sin(a)), y = 1 - Math.abs(Math.sin(b));
    const wx = THREE.MathUtils.lerp(x, Math.abs(Math.cos(a)), x);
    const wy = THREE.MathUtils.lerp(y, Math.abs(Math.cos(b)), y);
    return Math.pow(1 - Math.pow(wx * wy, 0.65), choppy);
  };

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, tau = Math.PI * 2;
    heights[y * size + x] = octave(
      u * tau * 2,
      v * tau * 2,
      noise(u * 8, v * 8, 8),
      Math.max(1, choppiness),
    ) + octave(
      (u + v) * tau * 4,
      (v - u) * tau * 4,
      noise(u * 16, v * 16, 16),
      2,
    ) * 0.22 + octave(
      u * tau * 13,
      v * tau * 11,
      noise(u * 32, v * 32, 32),
      1.5,
    ) * 0.055;
  }

  const height = (x, y) => heights[((y + size) % size) * size + (x + size) % size];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const dx = (height(x + 1, y) - height(x - 1, y)) * size / 64;
    const dz = (height(x, y + 1) - height(x, y - 1)) * size / 64;
    const encodedX = dx / SEA_DETAIL_SLOPE_RANGE * 0.5 + 0.5;
    const encodedZ = dz / SEA_DETAIL_SLOPE_RANGE * 0.5 + 0.5;
    const moment = (dx * dx + dz * dz) / SEA_DETAIL_MOMENT_SCALE;
    data[i] = Math.round(THREE.MathUtils.clamp(encodedX, 0, 1) * 255);
    data[i + 1] = Math.round(THREE.MathUtils.clamp(encodedZ, 0, 1) * 255);
    data[i + 2] = Math.round(THREE.MathUtils.clamp(height(x, y) / 1.275, 0, 1) * 255);
    data[i + 3] = Math.round(THREE.MathUtils.clamp(moment, 0, 1) * 255);
  }

  const result = new THREE.DataTexture(data, size, size);
  result.wrapS = result.wrapT = THREE.RepeatWrapping;
  result.minFilter = THREE.LinearMipmapLinearFilter;
  result.magFilter = THREE.LinearFilter;
  result.generateMipmaps = true;
  result.anisotropy = 8;
  result.needsUpdate = true;
  return result;
}
