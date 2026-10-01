import * as THREE from 'three';
import { rasterizeTerrain } from './rasterizeTerrain.js';
import { createTerrainNormalDataTexture, createTerrainNormalTexture } from '../grass/terrainNormals.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const MISS_HEIGHT = Number.NEGATIVE_INFINITY;

function nextFrame() {
  // Loading must also progress in a background tab, where animation frames pause.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class TerrainSampler {
  constructor(terrain, config) {
    this.terrain = terrain;
    this.config = config;
    this.target = terrain?.getObjectByName(config.terrain.targetMeshName) ?? terrain;
    this.resolution = config.terrain.heightResolution;
    this.bounds = new THREE.Box3();
    this.size = new THREE.Vector3();
    this.heights = new Float32Array(this.resolution * this.resolution);
    this.heights.fill(MISS_HEIGHT);
    this.texture = null;
    this.normalTexture = null;
    this.ready = false;
  }

  async build(onProgress = () => {}) {
    return this.#build(onProgress, true);
  }

  async buildHeightOnly(onProgress = () => {}) {
    return this.#build(onProgress, false);
  }

  loadBaked({ resolution, bounds, heights, normalData }) {
    if (resolution !== this.resolution) {
      throw new Error(`Baked terrain resolution ${resolution} does not match ${this.resolution}.`);
    }
    if (heights.length !== resolution * resolution) {
      throw new Error('Baked terrain height field has an invalid length.');
    }
    if (normalData && normalData.length !== resolution * resolution * 4) {
      throw new Error('Baked terrain normal map has an invalid length.');
    }
    this.bounds.set(
      new THREE.Vector3().fromArray(bounds.min),
      new THREE.Vector3().fromArray(bounds.max),
    );
    this.bounds.getSize(this.size);
    this.heights = heights;
    this.#createTexture(normalData);
    this.ready = true;
    return this;
  }

  async #build(onProgress, createTextures) {
    if (!this.target) {
      this.#buildFlatFallback(createTextures);
      return this;
    }

    this.target.updateWorldMatrix(true, true);
    this.bounds.setFromObject(this.target);
    this.bounds.getSize(this.size);

    if (!Number.isFinite(this.bounds.min.x) || this.size.x <= 0 || this.size.z <= 0) {
      this.#buildFlatFallback(createTextures);
      return this;
    }

    if (this.config.cinematic?.enabled) {
      this.heights = await rasterizeTerrain(this.target, this.bounds, this.resolution, onProgress);
      this.#finishBuild(createTextures);
      return this;
    }

    const raycaster = new THREE.Raycaster();
    const origin = new THREE.Vector3();
    const top = this.bounds.max.y + Math.max(10, this.size.y + 2);
    const far = Math.max(20, this.size.y * 3 + 20);
    const chunkRows = Math.max(1, this.config.terrain.sampleChunkRows ?? 6);

    for (let y = 0; y < this.resolution; y += 1) {
      const v = y / (this.resolution - 1);
      const z = THREE.MathUtils.lerp(this.bounds.min.z, this.bounds.max.z, v);

      for (let x = 0; x < this.resolution; x += 1) {
        const u = x / (this.resolution - 1);
        const worldX = THREE.MathUtils.lerp(this.bounds.min.x, this.bounds.max.x, u);
        origin.set(worldX, top, z);
        raycaster.set(origin, DOWN);
        raycaster.far = far;
        const hit = raycaster.intersectObject(this.target, true)[0];
        this.heights[y * this.resolution + x] = hit?.point.y ?? this.bounds.min.y;
      }

      if (y % chunkRows === 0) {
        onProgress((y + 1) / this.resolution);
        await nextFrame();
      }
    }

    this.#finishBuild(createTextures);
    onProgress(1);
    return this;
  }

  #buildFlatFallback(createTextures) {
    const size = this.config.terrain.fallbackSize ?? 160;
    this.bounds.set(
      new THREE.Vector3(-size * 0.5, 0, -size * 0.5),
      new THREE.Vector3(size * 0.5, 1, size * 0.5),
    );
    this.bounds.getSize(this.size);
    this.heights.fill(0);
    this.#finishBuild(createTextures);
  }

  #finishBuild(createTextures) {
    if (createTextures) this.#createTexture();
    else this.#disposeTextures();
    this.ready = true;
  }

  #disposeTextures() {
    this.texture?.dispose();
    this.normalTexture?.dispose();
    this.texture = null;
    this.normalTexture = null;
  }

  #createTexture(normalData = null) {
    const minHeight = this.bounds.min.y;
    const heightRange = Math.max(0.0001, this.bounds.max.y - minHeight);
    const precise = Boolean(this.config.terrain.expansion?.enabled);
    const data = precise ? new Uint16Array(this.resolution * this.resolution * 4)
      : new Uint8Array(this.resolution * this.resolution * 4);

    for (let index = 0; index < this.heights.length; index += 1) {
      const normalized = THREE.MathUtils.clamp((this.heights[index] - minHeight) / heightRange, 0, 1);
      const value = precise ? THREE.DataUtils.toHalfFloat(normalized) : Math.round(normalized * 255);
      const offset = index * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = precise ? THREE.DataUtils.toHalfFloat(1) : 255;
    }

    this.texture?.dispose();
    this.texture = new THREE.DataTexture(
      data,
      this.resolution,
      this.resolution,
      THREE.RGBAFormat,
      precise ? THREE.HalfFloatType : THREE.UnsignedByteType,
    );
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.flipY = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
    this.normalTexture?.dispose();
    this.normalTexture = this.config.cinematic?.enabled
      ? (normalData
        ? createTerrainNormalTexture(normalData, this.resolution)
        : createTerrainNormalDataTexture(this.heights, this.resolution, this.size))
      : null;
  }

  sampleHeight(x, z) {
    if (!this.ready || this.size.x <= 0 || this.size.z <= 0) return 0;
    const u = (x - this.bounds.min.x) / this.size.x;
    const v = (z - this.bounds.min.z) / this.size.z;
    if (u < 0 || u > 1 || v < 0 || v > 1) return this.bounds.min.y;

    const px = u * (this.resolution - 1);
    const py = v * (this.resolution - 1);
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const x1 = Math.min(this.resolution - 1, x0 + 1);
    const y1 = Math.min(this.resolution - 1, y0 + 1);
    const tx = px - x0;
    const ty = py - y0;

    const h00 = this.heights[y0 * this.resolution + x0];
    const h10 = this.heights[y0 * this.resolution + x1];
    const h01 = this.heights[y1 * this.resolution + x0];
    const h11 = this.heights[y1 * this.resolution + x1];
    const a = THREE.MathUtils.lerp(h00, h10, tx);
    const b = THREE.MathUtils.lerp(h01, h11, tx);
    return THREE.MathUtils.lerp(a, b, ty);
  }

  getHeightRange(box) {
    if (!this.ready || this.size.x <= 0 || this.size.z <= 0) {
      return { min: this.bounds.min.y, max: this.bounds.max.y };
    }

    const uMin = THREE.MathUtils.clamp((box.min.x - this.bounds.min.x) / this.size.x, 0, 1);
    const uMax = THREE.MathUtils.clamp((box.max.x - this.bounds.min.x) / this.size.x, 0, 1);
    const vMin = THREE.MathUtils.clamp((box.min.z - this.bounds.min.z) / this.size.z, 0, 1);
    const vMax = THREE.MathUtils.clamp((box.max.z - this.bounds.min.z) / this.size.z, 0, 1);
    const xMin = Math.floor(uMin * (this.resolution - 1));
    const xMax = Math.ceil(uMax * (this.resolution - 1));
    const zMin = Math.floor(vMin * (this.resolution - 1));
    const zMax = Math.ceil(vMax * (this.resolution - 1));
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (let z = zMin; z <= zMax; z += 1) {
      for (let x = xMin; x <= xMax; x += 1) {
        const height = this.heights[z * this.resolution + x];
        if (!Number.isFinite(height)) continue;
        min = Math.min(min, height);
        max = Math.max(max, height);
      }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { min: this.bounds.min.y, max: this.bounds.max.y };
    }
    return { min, max };
  }

  worldToUv(x, z, target = new THREE.Vector2()) {
    target.set(
      THREE.MathUtils.clamp((x - this.bounds.min.x) / Math.max(this.size.x, 0.0001), 0, 1),
      THREE.MathUtils.clamp((z - this.bounds.min.z) / Math.max(this.size.z, 0.0001), 0, 1),
    );
    return target;
  }

  contains(x, z, padding = 0) {
    return x >= this.bounds.min.x + padding
      && x <= this.bounds.max.x - padding
      && z >= this.bounds.min.z + padding
      && z <= this.bounds.max.z - padding;
  }

  getShaderData() {
    return {
      texture: this.texture,
      normalTexture: this.normalTexture ?? null,
      boundsMin: this.bounds.min,
      boundsSize: this.size,
      minHeight: this.bounds.min.y,
      maxHeight: this.bounds.max.y,
    };
  }
}
