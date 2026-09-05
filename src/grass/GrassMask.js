import * as THREE from 'three';
import { assetUrl } from '../assets/assetUrl.js';
import { VegetationMask } from './VegetationMask.js';
import { resolveVegetationPolicy } from './vegetationPolicy.js';

const EMPTY_MASK_VALUE = 255;
const FULL_GRASS_MASK_VALUE = 0;

function loadImage(path) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = assetUrl(path);
  });
}

export class GrassMask {
  constructor(config, terrainSampler) {
    this.config = config;
    this.terrainSampler = terrainSampler;
    this.resolution = config.painter.resolution;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.resolution;
    this.canvas.height = this.resolution;
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.context.fillStyle = '#000000';
    this.context.fillRect(0, 0, this.resolution, this.resolution);
    this.imageData = null;
    this.dirtyRect = null;
    this.vegetation = new VegetationMask(this.resolution, resolveVegetationPolicy(config));
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.flipY = true;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
  }

  async load() {
    const path = this.config.assets?.grassMask;
    if (!path) {
      this.#refreshPixels();
      return;
    }

    try {
      const image = await loadImage(path);
      this.context.clearRect(0, 0, this.resolution, this.resolution);
      this.context.drawImage(image, 0, 0, this.resolution, this.resolution);
      this.#refreshPixels();
    } catch (error) {
      console.warn('Unable to load grass mask, using full-coverage fallback', error);
      this.context.fillStyle = '#000000';
      this.context.fillRect(0, 0, this.resolution, this.resolution);
      this.#refreshPixels();
    }
  }

  #refreshPixels() {
    this.imageData = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.texture.needsUpdate = true;
    this.dirtyRect = null;
    this.vegetation.rebuild(this.imageData, this.terrainSampler.size);
  }

  get vegetationTexture() {
    return this.vegetation.texture;
  }

  // Re-dilate only the region painted since the last flush. Called once per frame
  // by GrassPainter so a stroke never triggers a full-resolution dilation.
  flushVegetation() {
    if (!this.dirtyRect) return false;
    this.vegetation.rebuild(this.imageData, this.terrainSampler.size, this.dirtyRect);
    this.dirtyRect = null;
    return true;
  }

  #markDirty(x, y, radius) {
    const rect = {
      x: x - radius,
      y: y - radius,
      width: radius * 2 + 1,
      height: radius * 2 + 1,
    };
    if (!this.dirtyRect) {
      this.dirtyRect = rect;
      return;
    }
    const right = Math.max(this.dirtyRect.x + this.dirtyRect.width, rect.x + rect.width);
    const bottom = Math.max(this.dirtyRect.y + this.dirtyRect.height, rect.y + rect.height);
    this.dirtyRect.x = Math.min(this.dirtyRect.x, rect.x);
    this.dirtyRect.y = Math.min(this.dirtyRect.y, rect.y);
    this.dirtyRect.width = right - this.dirtyRect.x;
    this.dirtyRect.height = bottom - this.dirtyRect.y;
  }

  worldToUv(x, z, target = new THREE.Vector2()) {
    this.terrainSampler.worldToUv(x, z, target);
    if (this.config.painter.flipU) target.x = 1 - target.x;
    if (this.config.painter.flipV) target.y = 1 - target.y;
    return target;
  }

  // The single mask sampler. Bilinear like the GPU's LinearFilter, dilated by the
  // path clearance and hardened by the cutoff, so the CPU and the shader agree on
  // where a path is. Returns 0 outside the terrain bounds.
  sampleWorld(x, z) {
    return this.vegetation.sampleWorld(x, z, this.terrainSampler.bounds);
  }

  allowsVegetation(x, z) {
    return this.vegetation.allows(x, z, this.terrainSampler.bounds);
  }

  createEmptyTileSet(terrainSizeX, terrainSizeZ, tileSize) {
    const emptyTiles = new Set();
    if (!this.imageData) return emptyTiles;

    const { width, height, data } = this.vegetation.imageData;
    const grassRed = EMPTY_MASK_VALUE * (1 - this.vegetation.policy.cutoff);
    const terrainTilesX = Math.ceil(terrainSizeX / tileSize);
    const terrainTilesZ = Math.ceil(terrainSizeZ / tileSize);
    const pixelsPerTileX = width / terrainTilesX;
    const pixelsPerTileZ = height / terrainTilesZ;

    for (let tileZ = 0; tileZ < terrainTilesZ; tileZ += 1) {
      for (let tileX = 0; tileX < terrainTilesX; tileX += 1) {
        const startX = Math.floor(tileX * pixelsPerTileX);
        const endX = Math.floor((tileX + 1) * pixelsPerTileX);
        const startY = Math.floor(tileZ * pixelsPerTileZ);
        const endY = Math.floor((tileZ + 1) * pixelsPerTileZ);
        let hasGrass = false;

        for (let y = startY; y < endY && !hasGrass; y += 1) {
          for (let x = startX; x < endX; x += 1) {
            if (data[(y * width + x) * 4] < grassRed) {
              hasGrass = true;
              break;
            }
          }
        }

        if (!hasGrass) emptyTiles.add(`${tileX},${tileZ}`);
      }
    }
    return emptyTiles;
  }

  paintUv(uv, radius, value) {
    const x = uv.x * this.resolution;
    const y = uv.y * this.resolution;
    const clampedValue = THREE.MathUtils.clamp(Math.round(value), FULL_GRASS_MASK_VALUE, EMPTY_MASK_VALUE);
    const gradient = this.context.createRadialGradient(x, y, 0, x, y, radius);
    const shade = `rgb(${clampedValue}, ${clampedValue}, ${clampedValue})`;
    gradient.addColorStop(0, shade);
    gradient.addColorStop(0.7, shade);
    gradient.addColorStop(1, `rgba(${clampedValue},${clampedValue},${clampedValue},0)`);
    this.context.save();
    this.context.globalCompositeOperation = 'source-over';
    this.context.fillStyle = gradient;
    this.context.beginPath();
    this.context.arc(x, y, radius, 0, Math.PI * 2);
    this.context.fill();
    this.context.restore();
    this.#refreshPixels();
  }

  paintUvHard(uv, radius, value) {
    if (!this.imageData) this.#refreshPixels();
    const { width, height, data } = this.imageData;
    const centerX = Math.floor(uv.x * width);
    const centerY = Math.floor(uv.y * height);
    const brushRadius = Math.max(0, Math.floor(radius));
    const radiusSquared = brushRadius * brushRadius;
    const shade = THREE.MathUtils.clamp(
      Math.round(value),
      FULL_GRASS_MASK_VALUE,
      EMPTY_MASK_VALUE,
    );

    for (let offsetY = -brushRadius; offsetY <= brushRadius; offsetY += 1) {
      const y = centerY + offsetY;
      if (y < 0 || y >= height) continue;
      for (let offsetX = -brushRadius; offsetX <= brushRadius; offsetX += 1) {
        if (offsetX * offsetX + offsetY * offsetY > radiusSquared) continue;
        const x = centerX + offsetX;
        if (x < 0 || x >= width) continue;
        const index = (y * width + x) * 4;
        data[index] = shade;
        data[index + 1] = shade;
        data[index + 2] = shade;
        data[index + 3] = EMPTY_MASK_VALUE;
      }
    }
    this.#markDirty(centerX, centerY, brushRadius);
  }

  commitPixels() {
    if (!this.imageData) return;
    this.context.putImageData(this.imageData, 0, 0);
    this.texture.needsUpdate = true;
  }

  clear(value = EMPTY_MASK_VALUE) {
    const shade = THREE.MathUtils.clamp(Math.round(value), FULL_GRASS_MASK_VALUE, EMPTY_MASK_VALUE);
    this.context.fillStyle = `rgb(${shade}, ${shade}, ${shade})`;
    this.context.fillRect(0, 0, this.resolution, this.resolution);
    this.#refreshPixels();
  }

  dispose() {
    this.vegetation.dispose();
    this.texture.dispose();
  }

  download(filename = 'grass-mask.jpg') {
    const link = document.createElement('a');
    link.download = filename;
    link.href = this.canvas.toDataURL('image/jpeg', 0.95);
    link.click();
  }
}
