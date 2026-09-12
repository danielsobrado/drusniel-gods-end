import * as THREE from 'three';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';
import { clamp01, computeVegetationEcology, encodeVegetationShaderExclusion, fractalNoise, hash2d, vegetationCoverageChance } from './vegetationEcology.js';
import { sampleCoastField } from '../world/CoastField.js';
import { coastalJungleRegionWeight } from '../world/CoastalJungleRegion.js';

const CHANNELS = 5;
const DENSITY = 0;
const GROWTH = 1;
const MOISTURE = 2;
const UNDERSTORY = 3;
const PATH = 4;

function nextFrame() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function worldDistanceTransform(pathPixels, resolution, cellX, cellZ) {
  const distances = new Float32Array(resolution * resolution);
  const diagonal = Math.hypot(cellX, cellZ);
  for (let index = 0; index < distances.length; index += 1) {
    distances[index] = pathPixels[index] ? 0 : Number.POSITIVE_INFINITY;
  }

  const relax = (index, other, cost) => {
    if (other < 0 || other >= distances.length) return;
    distances[index] = Math.min(distances[index], distances[other] + cost);
  };

  for (let z = 0; z < resolution; z += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const index = z * resolution + x;
      if (x > 0) relax(index, index - 1, cellX);
      if (z > 0) relax(index, index - resolution, cellZ);
      if (x > 0 && z > 0) relax(index, index - resolution - 1, diagonal);
      if (x + 1 < resolution && z > 0) relax(index, index - resolution + 1, diagonal);
    }
  }

  for (let z = resolution - 1; z >= 0; z -= 1) {
    for (let x = resolution - 1; x >= 0; x -= 1) {
      const index = z * resolution + x;
      if (x + 1 < resolution) relax(index, index + 1, cellX);
      if (z + 1 < resolution) relax(index, index + resolution, cellZ);
      if (x + 1 < resolution && z + 1 < resolution) relax(index, index + resolution + 1, diagonal);
      if (x > 0 && z + 1 < resolution) relax(index, index + resolution - 1, diagonal);
    }
  }

  return distances;
}

async function loadPathPixels(config, resolution, bounds, size) {
  const path = config.assets?.groundBlend;
  if (!path) return new Uint8Array(resolution * resolution);

  const texture = await new THREE.TextureLoader().loadAsync(assetUrl(path));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = resolution;
    canvas.height = resolution;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas context unavailable.');
    if (config.terrain.expansion?.enabled) {
      context.drawImage(texture.image, (-480 - bounds.min.x) / size.x * resolution,
        (bounds.max.z - 480) / size.z * resolution, 960 / size.x * resolution, 960 / size.z * resolution);
    } else context.drawImage(texture.image, 0, 0, resolution, resolution);
    const image = context.getImageData(0, 0, resolution, resolution);
    const threshold = Math.round(clamp01(config.vegetation.path.sourceThreshold) * 255);
    const pixels = new Uint8Array(resolution * resolution);
    for (let z = 0; z < resolution; z += 1) {
      const sourceZ = resolution - 1 - z;
      for (let x = 0; x < resolution; x += 1) {
        const source = (sourceZ * resolution + x) * 4;
        pixels[z * resolution + x] = image.data[source] >= threshold ? 1 : 0;
      }
    }
    return pixels;
  } finally {
    texture.dispose();
  }
}

function rasterizeTrees(trees, bounds, size, resolution, config) {
  const shade = new Float32Array(resolution * resolution);
  const nearest = new Float32Array(resolution * resolution);
  nearest.fill(Number.POSITIVE_INFINITY);
  const cellX = size.x / Math.max(1, resolution - 1);
  const cellZ = size.z / Math.max(1, resolution - 1);
  const radius = config.trees.shadeRadius;

  for (const tree of trees ?? []) {
    const position = tree.position;
    if (!position) continue;
    const centerX = (position.x - bounds.min.x) / Math.max(size.x, 0.0001) * (resolution - 1);
    const centerZ = (position.z - bounds.min.z) / Math.max(size.z, 0.0001) * (resolution - 1);
    const radiusX = Math.ceil(radius / Math.max(cellX, 0.0001));
    const radiusZ = Math.ceil(radius / Math.max(cellZ, 0.0001));
    const minX = Math.max(0, Math.floor(centerX - radiusX));
    const maxX = Math.min(resolution - 1, Math.ceil(centerX + radiusX));
    const minZ = Math.max(0, Math.floor(centerZ - radiusZ));
    const maxZ = Math.min(resolution - 1, Math.ceil(centerZ + radiusZ));

    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = (x - centerX) * cellX;
        const dz = (z - centerZ) * cellZ;
        const distance = Math.hypot(dx, dz);
        if (distance > radius) continue;
        const index = z * resolution + x;
        nearest[index] = Math.min(nearest[index], distance);
        shade[index] = Math.max(shade[index], 1 - distance / radius);
      }
    }
  }

  return { shade, nearest };
}

function sampleArrayBilinear(data, resolution, u, v, channel, channels = CHANNELS) {
  const px = clamp01(u) * (resolution - 1);
  const pz = clamp01(v) * (resolution - 1);
  const x0 = Math.floor(px);
  const z0 = Math.floor(pz);
  const x1 = Math.min(resolution - 1, x0 + 1);
  const z1 = Math.min(resolution - 1, z0 + 1);
  const tx = px - x0;
  const tz = pz - z0;
  const at = (x, z) => data[(z * resolution + x) * channels + channel];
  const top = at(x0, z0) + (at(x1, z0) - at(x0, z0)) * tx;
  const bottom = at(x0, z1) + (at(x1, z1) - at(x0, z1)) * tx;
  return top + (bottom - top) * tz;
}

function waterMetrics(config, x, z, height) {
  const position = config.water?.position ?? config.water?.fallbackPosition ?? [0, 0, 0];
  const centerX = Number(position[0] ?? 0);
  const surfaceY = Number(position[1] ?? 0);
  const centerZ = Number(position[2] ?? 0);
  const size = Math.max(0, Number(config.water?.size ?? config.water?.fallbackSize ?? 0));
  const half = size * 0.5;
  if (!(half > 0)) {
    return {
      distance: Math.hypot(x - centerX, z - centerZ),
      submerged: false,
    };
  }

  const localX = Math.abs(x - centerX);
  const localZ = Math.abs(z - centerZ);
  const dx = Math.max(localX - half, 0);
  const dz = Math.max(localZ - half, 0);
  const insideFootprint = localX <= half && localZ <= half;
  const tolerance = config.vegetation.moisture.waterSurfaceTolerance;
  return {
    distance: Math.hypot(dx, dz, Math.max(0, height - surfaceY) * 3),
    submerged: insideFootprint && height <= surfaceY + tolerance,
  };
}

function applyCoastalJungleEcology(ecology, config, sea, x, z) {
  const profile = config.biomes?.coastalJungle;
  if (!profile?.enabled || !sea?.enabled) return;
  const settings = profile.ecology ?? {};
  const weight = coastalJungleRegionWeight(x, z, profile.region, sea, settings.edgeFade ?? 18);
  if (weight <= 0) return;
  const baseScale = clamp01(settings.baseVegetationScale ?? 0.18);
  const scale = 1 - weight * (1 - baseScale);
  ecology.density *= scale;
  ecology.growth *= scale;
  ecology.understory *= scale;
}

export class ProceduralVegetationField {
  constructor(config, terrainSampler, trees = []) {
    this.config = config;
    this.terrainSampler = terrainSampler;
    this.trees = trees;
    this.resolution = config.vegetation.resolution;
    this.bounds = terrainSampler.bounds;
    this.size = terrainSampler.size;
    this.data = new Float32Array(this.resolution * this.resolution * CHANNELS);
    this.texture = null;
    this.vegetationTexture = null;
    this.ready = false;
  }

  async build(onProgress = () => {}) {
    const vegetation = this.config.vegetation;
    const resolution = this.resolution;
    const cellX = this.size.x / Math.max(1, resolution - 1);
    const cellZ = this.size.z / Math.max(1, resolution - 1);
    let pathPixels;
    try {
      if (this.terrainSampler.paths) {
        pathPixels = new Uint8Array(resolution * resolution);
        for (let z = 0; z < resolution; z++) for (let x = 0; x < resolution; x++) {
          pathPixels[z * resolution + x] = this.terrainSampler.paths.sample(
            this.bounds.min.x + x / (resolution - 1) * this.size.x,
            this.bounds.min.z + z / (resolution - 1) * this.size.z) > 0.45 ? 1 : 0;
        }
      } else pathPixels = await loadPathPixels(this.config, resolution, this.bounds, this.size);
    } catch (error) {
      logger.warn('Ground blend could not seed dirt-way proximity; continuing without authored paths.', error);
      pathPixels = new Uint8Array(resolution * resolution);
    }
    const pathDistance = worldDistanceTransform(pathPixels, resolution, cellX, cellZ);
    const treeField = rasterizeTrees(this.trees, this.bounds, this.size, resolution, vegetation);
    const heightRange = Math.max(0.0001, this.bounds.max.y - this.bounds.min.y);
    const slopeStep = vegetation.terrain.slopeSampleDistance;

    for (let z = 0; z < resolution; z += 1) {
      const v = z / Math.max(1, resolution - 1);
      const worldZ = this.bounds.min.z + this.size.z * v;
      for (let x = 0; x < resolution; x += 1) {
        const u = x / Math.max(1, resolution - 1);
        const worldX = this.bounds.min.x + this.size.x * u;
        const height = this.terrainSampler.sampleHeight(worldX, worldZ);
        const heightX = this.terrainSampler.sampleHeight(worldX + slopeStep, worldZ);
        const heightZ = this.terrainSampler.sampleHeight(worldX, worldZ + slopeStep);
        const slope = Math.hypot(heightX - height, heightZ - height) / Math.max(slopeStep, 0.0001);
        const height01 = clamp01((height - this.bounds.min.y) / heightRange);
        const macroNoise = fractalNoise(
          worldX * vegetation.noise.macroScale,
          worldZ * vegetation.noise.macroScale,
          vegetation.seed,
          vegetation.noise.octaves,
        );
        const detailNoise = fractalNoise(
          worldX * vegetation.noise.detailScale,
          worldZ * vegetation.noise.detailScale,
          vegetation.seed + 7919,
          vegetation.noise.octaves,
        );
        const water = waterMetrics(this.config, worldX, worldZ, height);
        const sea = this.config.water.sea;
        const coastField = sea?.enabled ? sampleCoastField(worldX, worldZ, 0, sea) : null;
        const coastDistance = coastField ? -coastField.signedCoastDistance : Infinity;
        if (coastField) {
          water.distance = Math.min(water.distance, Math.max(0, coastDistance));
          water.submerged ||= coastField.signedCoastDistance > -30 && height < sea.level + 0.15;
        }
        const river = this.terrainSampler.river?.sample(worldX, worldZ);
        if (river) {
          water.distance = Math.min(water.distance, Math.max(0, river.edge));
          water.submerged ||= river.edge < 1.3 && height < river.y + 0.8;
        }
        const index = z * resolution + x;
        const ecology = computeVegetationEcology({
          height01,
          slope,
          pathDistance: pathDistance[index],
          treeShade: treeField.shade[index],
          nearestTreeDistance: treeField.nearest[index],
          waterDistance: water.distance,
          submerged: water.submerged,
          macroNoise,
          detailNoise,
        }, vegetation);
        if (this.config.terrain.expansion?.enabled) {
          const alpine = 1 - THREE.MathUtils.smoothstep(height, 95, 125);
          const rocky = Math.hypot((worldX - 390) / 170, (worldZ + 220) / 160);
          const soil = THREE.MathUtils.lerp(0.08, 1, THREE.MathUtils.smoothstep(rocky, 0.25, 1.1));
          ecology.density *= alpine * soil;
          ecology.growth *= alpine * soil;
          ecology.understory *= alpine * soil;
          const duneGrowth = coastField?.vegetationSuitability ?? 1;
          ecology.density *= duneGrowth; ecology.growth *= duneGrowth; ecology.understory *= duneGrowth;
        }
        applyCoastalJungleEcology(ecology, this.config, sea, worldX, worldZ);
        const offset = index * CHANNELS;
        this.data[offset + DENSITY] = ecology.density;
        this.data[offset + GROWTH] = ecology.growth;
        this.data[offset + MOISTURE] = ecology.moisture;
        this.data[offset + UNDERSTORY] = ecology.understory;
        this.data[offset + PATH] = ecology.path;
      }
      if (z % vegetation.buildChunkRows === 0) {
        onProgress((z + 1) / resolution);
        await nextFrame();
      }
    }

    this.#createTexture();
    this.ready = true;
    onProgress(1);
    return this;
  }

  #createTexture() {
    const pixels = new Uint8Array(this.resolution * this.resolution * 4);
    const growthThreshold = this.config.vegetation.growthThreshold;
    for (let index = 0; index < this.resolution * this.resolution; index += 1) {
      const source = index * CHANNELS;
      const target = index * 4;
      pixels[target] = Math.round(encodeVegetationShaderExclusion({
        density: this.data[source + DENSITY],
        path: this.data[source + PATH],
      }, growthThreshold) * 255);
      pixels[target + 1] = Math.round(this.data[source + MOISTURE] * 255);
      pixels[target + 2] = Math.round(this.data[source + UNDERSTORY] * 255);
      pixels[target + 3] = Math.round(this.data[source + PATH] * 255);
    }
    this.texture?.dispose();
    this.texture = new THREE.DataTexture(
      pixels,
      this.resolution,
      this.resolution,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.flipY = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
    this.vegetationTexture = this.texture;
  }

  sampleWorld(x, z) {
    if (!this.ready || !this.contains(x, z)) {
      return { density: 0, growth: 0, moisture: 0, understory: 0, path: 1 };
    }
    const u = (x - this.bounds.min.x) / Math.max(this.size.x, 0.0001);
    const v = (z - this.bounds.min.z) / Math.max(this.size.z, 0.0001);
    return {
      density: sampleArrayBilinear(this.data, this.resolution, u, v, DENSITY),
      growth: sampleArrayBilinear(this.data, this.resolution, u, v, GROWTH),
      moisture: sampleArrayBilinear(this.data, this.resolution, u, v, MOISTURE),
      understory: sampleArrayBilinear(this.data, this.resolution, u, v, UNDERSTORY),
      path: sampleArrayBilinear(this.data, this.resolution, u, v, PATH),
    };
  }

  allowsVegetation(x, z) {
    const sample = this.sampleWorld(x, z);
    const chance = vegetationCoverageChance(
      sample.density,
      this.config.vegetation.growthThreshold,
    );
    if (chance <= 0) return false;
    if (chance >= 1) return true;
    const scale = this.config.vegetation.distributionCellSize;
    const ix = Math.floor(x / scale);
    const iz = Math.floor(z / scale);
    return hash2d(ix, iz, this.config.vegetation.seed + 3571) < chance;
  }

  createEmptyTileSet(terrainSizeX, terrainSizeZ, tileSize) {
    const occupied = new Set();
    const threshold = this.config.vegetation.growthThreshold;
    for (let z = 0; z < this.resolution; z += 1) {
      for (let x = 0; x < this.resolution; x += 1) {
        const index = (z * this.resolution + x) * CHANNELS;
        if (this.data[index + DENSITY] <= threshold) continue;
        const worldX = this.bounds.min.x + (x / Math.max(1, this.resolution - 1)) * terrainSizeX;
        const worldZ = this.bounds.min.z + (z / Math.max(1, this.resolution - 1)) * terrainSizeZ;
        occupied.add(`${Math.floor((worldX - this.bounds.min.x) / tileSize)},${Math.floor((worldZ - this.bounds.min.z) / tileSize)}`);
      }
    }
    const empty = new Set();
    const tilesX = Math.ceil(terrainSizeX / tileSize);
    const tilesZ = Math.ceil(terrainSizeZ / tileSize);
    for (let z = 0; z < tilesZ; z += 1) {
      for (let x = 0; x < tilesX; x += 1) {
        const key = `${x},${z}`;
        if (!occupied.has(key)) empty.add(key);
      }
    }
    return empty;
  }

  contains(x, z) {
    return x >= this.bounds.min.x && x <= this.bounds.max.x
      && z >= this.bounds.min.z && z <= this.bounds.max.z;
  }

  dispose() {
    this.texture?.dispose();
    this.texture = null;
    this.vegetationTexture = null;
  }
}
