import { DataTexture, RGBAFormat, UnsignedByteType, LinearFilter } from 'three';
import { clamp01, fractalNoise, hash2d } from '../grass/vegetationEcology.js';

export function fieldCoordinates(x, z, bounds, resolution) {
  const u = clamp01((x - bounds.min.x) / (bounds.max.x - bounds.min.x));
  const v = clamp01((z - bounds.min.z) / (bounds.max.z - bounds.min.z));
  return { x: u * (resolution - 1), z: v * (resolution - 1),
    u: (u * (resolution - 1) + 0.5) / resolution,
    v: (v * (resolution - 1) + 0.5) / resolution };
}

export function grassArchetype(mass) {
  const smooth = (edge, value) => {
    const t = clamp01((value - edge + 0.04) / 0.08);
    return t * t * (3 - 2 * t);
  };
  const middle = smooth(0.38, mass), tall = smooth(0.68, mass);
  return { height: 0.6 + 0.4 * middle + 0.3 * tall,
    width: 0.85 + 0.3 * middle - 0.5 * tall,
    retention: 0.7 + 0.3 * middle - 0.15 * tall };
}

/** Endpoint grid, with explicit texel-center UVs shared by CPU and GPU. */
export class ReferenceBiomeField {
  constructor(ecology, seed, resolution = 1024) {
    this.ecology = ecology;
    this.bounds = ecology.bounds;
    this.seed = seed;
    this.resolution = resolution;
    this.data = new Uint8Array(resolution * resolution * 4);
    this.texture = new DataTexture(this.data, resolution, resolution, RGBAFormat, UnsignedByteType);
    this.texture.minFilter = this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
  }

  *build(signal) {
    const n = this.resolution;
    for (let row = 0; row < n; row++) {
      const z = this.bounds.min.z + row / (n - 1) * (this.bounds.max.z - this.bounds.min.z);
      for (let column = 0; column < n; column++) {
        const x = this.bounds.min.x + column / (n - 1) * (this.bounds.max.x - this.bounds.min.x);
        const ecology = this.ecology.sampleWorld(x, z);
        const noise = (scale, offset) => fractalNoise(x / scale, z / scale, this.seed + offset, 1);
        const dryness = clamp01(0.65 * (1 - ecology.moisture) + 0.35 * noise(32, 101));
        const offset = (row * n + column) * 4;
        this.data[offset] = Math.round(dryness * 255);
        this.data[offset + 1] = Math.round(clamp01(ecology.growth * (1 - 0.25 * dryness)) * 255);
        this.data[offset + 2] = Math.round(clamp01(0.75 * noise(8, 211) + 0.25 * noise(24, 307)) * 255);
        if ((column & 63) === 63) { signal?.throwIfAborted(); yield; }
      }
    }
    this.texture.needsUpdate = true;
  }

  sampleWorld(x, z) {
    const n = this.resolution;
    const p = fieldCoordinates(x, z, this.bounds, n);
    const x0 = Math.floor(p.x), z0 = Math.floor(p.z);
    const x1 = Math.min(n - 1, x0 + 1), z1 = Math.min(n - 1, z0 + 1);
    const tx = p.x - x0, tz = p.z - z0;
    const at = (x, z, c) => this.data[(z * n + x) * 4 + c] / 255;
    const channel = c => (at(x0, z0, c) * (1 - tx) + at(x1, z0, c) * tx) * (1 - tz)
      + (at(x0, z1, c) * (1 - tx) + at(x1, z1, c) * tx) * tz;
    return { dryness: channel(0), vigor: channel(1), mass: channel(2), exposure: channel(3) };
  }

  retainsGrass(x, z) {
    return hash2d(Math.floor(x * 16), Math.floor(z * 16), this.seed + 401)
      < grassArchetype(this.sampleWorld(x, z).mass).retention;
  }

  *exposeGround(footprints) {
    const n = this.resolution;
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      const wx = this.bounds.min.x + x / (n - 1) * (this.bounds.max.x - this.bounds.min.x);
      const wz = this.bounds.min.z + z / (n - 1) * (this.bounds.max.z - this.bounds.min.z);
      this.data[(z * n + x) * 4 + 3] = Math.round(footprints.exposure(wx, wz) * 255);
      if ((x & 127) === 127) yield;
    }
    this.texture.needsUpdate = true;
  }

  dispose() { this.texture.dispose(); }
}
