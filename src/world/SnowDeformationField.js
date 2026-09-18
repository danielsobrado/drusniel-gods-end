import * as THREE from 'three';
import { sampleSandCoverageCpu } from './CoastField.js';
import { SnowRegionBounds } from './SnowRegionBounds.js';

const CHANNELS = 4;
const DEPRESSION = 0;
const BERM = 1;
const GRADIENT_X = 2;
const GRADIENT_Z = 3;
const NEUTRAL_GRADIENT = 128;
const BYTE_MAX = 255;
const MIN_RADIUS = 0.001;

function positiveNumber(value, name) {
  const number = Number(value);
  if (!(number > 0) || !Number.isFinite(number)) throw new Error(`${name} must be a positive finite number.`);
  return number;
}

function positiveInteger(value, name) {
  const number = positiveNumber(value, name);
  if (!Number.isInteger(number)) throw new Error(`${name} must be a positive integer.`);
  return number;
}

function unitNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${name} must be in [0, 1].`);
  return number;
}

function emptySample() {
  return { depression: 0, berm: 0, gradientX: 0, gradientZ: 0 };
}

export function resolveSnowDeformationConfig(config) {
  if (!config) throw new Error('ground.snow.deformation configuration is required.');
  const resolution = positiveInteger(config.resolution, 'ground.snow.deformation.resolution');
  const minRadius = positiveNumber(config.minRadius, 'ground.snow.deformation.minRadius');
  const maxRadius = positiveNumber(config.maxRadius, 'ground.snow.deformation.maxRadius');
  if (maxRadius < minRadius) throw new Error('ground.snow.deformation.maxRadius must be >= minRadius.');
  return {
    enabled: config.enabled !== false,
    resolution,
    worldSize: positiveNumber(config.worldSize, 'ground.snow.deformation.worldSize'),
    paintMinCoverage: unitNumber(config.paintMinCoverage, 'ground.snow.deformation.paintMinCoverage'),
    footRadiusScale: positiveNumber(config.footRadiusScale, 'ground.snow.deformation.footRadiusScale'),
    stampSpacingScale: positiveNumber(config.stampSpacingScale, 'ground.snow.deformation.stampSpacingScale'),
    minRadius,
    maxRadius,
    contactHeight: positiveNumber(config.contactHeight, 'ground.snow.deformation.contactHeight'),
    recenterDistance: positiveNumber(config.recenterDistance, 'ground.snow.deformation.recenterDistance'),
    depressionStrength: unitNumber(config.depressionStrength, 'ground.snow.deformation.depressionStrength'),
    bermStrength: unitNumber(config.bermStrength, 'ground.snow.deformation.bermStrength'),
    decaySeconds: positiveNumber(config.decaySeconds, 'ground.snow.deformation.decaySeconds'),
    bermDecaySeconds: positiveNumber(config.bermDecaySeconds, 'ground.snow.deformation.bermDecaySeconds'),
    recoveryInterval: positiveNumber(config.recoveryInterval, 'ground.snow.deformation.recoveryInterval'),
  };
}

// Patches, tens of metres across, over which snow clings to steeper or only
// gentler ground, so rock breaks through a wall in places instead of along one
// contour of slope. In [-1, 1]; SnowSurface evaluates the same sines on the GPU.
export const SNOW_SLOPE_PATCH = Object.freeze({
  broad: [0.071, 0.037, 2.1, 0.063, 0.029, 1.7],
  fine: [0.19, 0.13, 0.083, 1.3],
});

export function snowSlopePatchCpu(x, z) {
  const [ax, az, aw, bz, bx, bw] = SNOW_SLOPE_PATCH.broad;
  const [fx, fz, fw, fa] = SNOW_SLOPE_PATCH.fine;
  const broad = Math.sin(x * ax + Math.sin(z * az) * aw) * Math.sin(z * bz + Math.sin(x * bx) * bw);
  const fine = Math.sin(x * fx - z * fz + Math.sin(x * fw) * fa);
  return (broad + fine * 0.5) / 1.5;
}

export function sampleSnowCoverageCpu(x, y, z, normalY, config) {
  const snow = config.ground?.snow;
  if (!snow?.enabled) return 0;
  const wind = snow.wind;
  const angle = Number(wind.angleDegrees) * Math.PI / 180;
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);
  const along = x * cosAngle + z * sinAngle;
  const across = -x * sinAngle + z * cosAngle;
  const drift = Math.sin(along * wind.driftFrequency + Math.sin(across * wind.crossFrequency) * wind.warp)
    * 0.5 + 0.5;
  const exposure = Math.sin(along * wind.exposureFrequency - across * wind.exposureCrossFrequency)
    * 0.5 + 0.5;
  const effectiveHeight = y + drift * wind.driftHeight - exposure * wind.scourStrength;
  const altitude = THREE.MathUtils.smoothstep(effectiveHeight, snow.altitude.start, snow.altitude.full);
  const shift = snowSlopePatchCpu(x, z) * Number(snow.slope.noise ?? 0);
  const slope = THREE.MathUtils.smoothstep(Math.abs(normalY), snow.slope.start + shift, snow.slope.full + shift);
  return THREE.MathUtils.clamp(altitude * slope, 0, 1);
}

// Terrain height with snow and beach-sand coverage at a point, the slope taken
// from a central difference `step` metres wide.
export function sampleSurfaceCpu(terrainSampler, x, z, step, config) {
  const terrainHeight = terrainSampler.sampleHeight(x, z);
  if (!Number.isFinite(terrainHeight)) return null;
  const xp = terrainSampler.sampleHeight(x + step, z);
  const xm = terrainSampler.sampleHeight(x - step, z);
  const zp = terrainSampler.sampleHeight(x, z + step);
  const zm = terrainSampler.sampleHeight(x, z - step);
  if (![xp, xm, zp, zm].every(Number.isFinite)) return null;
  const dx = xp - xm;
  const dz = zp - zm;
  const normalY = 1 / Math.sqrt(1 + (dx / (step * 2)) ** 2 + (dz / (step * 2)) ** 2);
  const sand = sampleSandCoverageCpu(x, terrainHeight, z, config);
  return {
    y: terrainHeight,
    snow: sampleSnowCoverageCpu(x, terrainHeight, z, normalY, config),
    sand: sand.coverage,
    sandDryness: sand.dryness,
  };
}

export function sampleSnowSurfaceCpu(terrainSampler, x, z, step, config) {
  const surface = sampleSurfaceCpu(terrainSampler, x, z, step, config);
  return surface && { y: surface.y, coverage: surface.snow };
}

export class SnowDeformationField {
  constructor(config, terrainSampler) {
    this.config = resolveSnowDeformationConfig(config.ground.snow.deformation);
    this.rootConfig = config;
    this.terrainSampler = terrainSampler;
    this.region = new SnowRegionBounds(terrainSampler, config);
    this.center = new THREE.Vector2();
    this.centerInitialized = false;
    this.recoveryElapsed = 0;
    this.peak = 0;
    this.lastContacts = [];
    this.occupied = new Set();
    this.lastRecoveryPixels = 0;
    const length = this.config.resolution * this.config.resolution * CHANNELS;
    this.pixels = new Uint8Array(length);
    this.scrollPixels = new Uint8Array(length);
    this.#clear(this.pixels);
    this.texture = new THREE.DataTexture(
      this.pixels,
      this.config.resolution,
      this.config.resolution,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.texture.name = 'SnowDeformationField';
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  update(deltaSeconds, playerPosition, influencePoints = [], moving = true) {
    if (!this.config.enabled || !playerPosition) return;
    this.#recenter(playerPosition.x, playerPosition.z);

    let changed = this.#recover(deltaSeconds);
    if (moving) {
      const points = influencePoints.length > 0
        ? influencePoints
        : [{ position: playerPosition, radius: this.config.minRadius }];
      for (let index = 0; index < points.length; index += 1) {
        changed = this.#paintSpacedPoint(points[index], index) || changed;
      }
      if (this.lastContacts.length > points.length) this.lastContacts.length = points.length;
    } else {
      this.lastContacts.length = 0;
    }
    if (changed) this.texture.needsUpdate = true;
  }

  #recenter(x, z) {
    if (!this.centerInitialized || this.peak === 0) {
      this.center.set(x, z);
      this.centerInitialized = true;
      return;
    }
    const deltaX = x - this.center.x;
    const deltaZ = z - this.center.y;
    if (Math.hypot(deltaX, deltaZ) < this.config.recenterDistance) return;

    const pixelsPerUnit = this.config.resolution / this.config.worldSize;
    const shiftX = Math.trunc(deltaX * pixelsPerUnit);
    const shiftY = Math.trunc(deltaZ * pixelsPerUnit);
    if (Math.abs(shiftX) >= this.config.resolution || Math.abs(shiftY) >= this.config.resolution) {
      this.clear();
      this.center.set(x, z);
      this.centerInitialized = true;
      return;
    }
    this.#scrollPixels(shiftX, shiftY);
    this.center.x += shiftX / pixelsPerUnit;
    this.center.y += shiftY / pixelsPerUnit;
  }

  #footprintRadius(point) {
    const sourceRadius = Number(point?.radius);
    const contactRadius = Number.isFinite(sourceRadius) && sourceRadius > 0
      ? sourceRadius
      : this.config.minRadius;
    return THREE.MathUtils.clamp(
      contactRadius * this.config.footRadiusScale,
      this.config.minRadius,
      this.config.maxRadius,
    );
  }

  #paintSpacedPoint(point, index) {
    const position = point?.position;
    if (!position) return false;
    const radius = this.#footprintRadius(point);
    const previous = this.lastContacts[index];
    const minimumDistance = radius * this.config.stampSpacingScale;
    if (previous && Math.hypot(position.x - previous.x, position.z - previous.y) < minimumDistance) {
      return false;
    }

    const painted = this.#paintPoint(point, radius);
    if (painted === null) return false;
    const contact = previous ?? new THREE.Vector2();
    contact.set(position.x, position.z);
    this.lastContacts[index] = contact;
    return painted;
  }

  #paintPoint(point, radius) {
    const position = point?.position;
    if (!position) return null;
    const x = position.x;
    const z = position.z;
    // Infinity gives an upper bound for the sand height mask; keep all coastal
    // contacts eligible even though the same field is used for alpine snow.
    if (!this.region.contains(x, z)
      && sampleSandCoverageCpu(x, Infinity, z, this.rootConfig).coverage === 0) return null;
    const terrainHeight = this.terrainSampler.sampleHeight(x, z);
    if (!Number.isFinite(terrainHeight)) return null;
    const sourceRadius = Number(point.radius);
    const contactRadius = Number.isFinite(sourceRadius) && sourceRadius > 0
      ? sourceRadius
      : this.config.minRadius;
    if (Number.isFinite(position.y)) {
      const bottom = position.y - contactRadius;
      const top = position.y + contactRadius;
      if (bottom > terrainHeight + this.config.contactHeight
        || top < terrainHeight - this.config.contactHeight) return null;
    }

    const step = Math.max(0.4, this.config.worldSize / this.config.resolution * 2);
    const dx = this.terrainSampler.sampleHeight(x + step, z) - this.terrainSampler.sampleHeight(x - step, z);
    const dz = this.terrainSampler.sampleHeight(x, z + step) - this.terrainSampler.sampleHeight(x, z - step);
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null;
    const normalY = 1 / Math.sqrt(1 + (dx / (step * 2)) ** 2 + (dz / (step * 2)) ** 2);
    // Beach sand takes prints as well as snow.
    const coverage = Math.max(
      sampleSnowCoverageCpu(x, terrainHeight, z, normalY, this.rootConfig),
      sampleSandCoverageCpu(x, terrainHeight, z, this.rootConfig).coverage,
    );
    if (coverage < this.config.paintMinCoverage) return null;

    const centerX = ((x - this.center.x) / this.config.worldSize + 0.5) * this.config.resolution;
    const centerY = ((z - this.center.y) / this.config.worldSize + 0.5) * this.config.resolution;
    const pixelRadius = Math.max(1, radius * this.config.resolution / this.config.worldSize);
    const bermRadius = pixelRadius * 1.55;
    const minX = Math.max(0, Math.floor(centerX - bermRadius));
    const maxX = Math.min(this.config.resolution - 1, Math.ceil(centerX + bermRadius));
    const minY = Math.max(0, Math.floor(centerY - bermRadius));
    const maxY = Math.min(this.config.resolution - 1, Math.ceil(centerY + bermRadius));
    let changed = false;

    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const vx = (px + 0.5 - centerX) / pixelRadius;
        const vz = (py + 0.5 - centerY) / pixelRadius;
        const distance = Math.hypot(vx, vz);
        if (distance > 1.55) continue;
        const offset = (py * this.config.resolution + px) * CHANNELS;

        if (distance <= 1) {
          const falloff = Math.max(0, 1 - distance * distance);
          const depression = Math.round(BYTE_MAX * this.config.depressionStrength * coverage * falloff);
          if (depression > this.pixels[offset + DEPRESSION]) {
            this.pixels[offset + DEPRESSION] = depression;
            const directionScale = distance > MIN_RADIUS ? depression / BYTE_MAX : 0;
            this.pixels[offset + GRADIENT_X] = Math.round(NEUTRAL_GRADIENT + vx * directionScale * 127);
            this.pixels[offset + GRADIENT_Z] = Math.round(NEUTRAL_GRADIENT + vz * directionScale * 127);
            this.occupied.add(offset);
            this.peak = Math.max(this.peak, depression);
            changed = true;
          }
          continue;
        }

        const ring = Math.max(0, 1 - Math.abs(distance - 1.22) / 0.33);
        const berm = Math.round(BYTE_MAX * this.config.bermStrength * coverage * ring);
        if (berm > this.pixels[offset + BERM]) {
          this.pixels[offset + BERM] = berm;
          this.occupied.add(offset);
          this.peak = Math.max(this.peak, berm);
          changed = true;
        }
      }
    }
    return changed;
  }

  #recover(deltaSeconds) {
    this.lastRecoveryPixels = 0;
    if (this.peak === 0) return false;
    this.recoveryElapsed += Math.max(0, deltaSeconds);
    if (this.recoveryElapsed < this.config.recoveryInterval) return false;
    const elapsed = this.recoveryElapsed;
    this.recoveryElapsed = 0;
    const depressionFactor = Math.exp(-elapsed / this.config.decaySeconds);
    const bermFactor = Math.exp(-elapsed / this.config.bermDecaySeconds);
    let peak = 0;
    this.lastRecoveryPixels = this.occupied.size;
    for (const index of this.occupied) {
      const depression = Math.floor(this.pixels[index + DEPRESSION] * depressionFactor);
      const berm = Math.floor(this.pixels[index + BERM] * bermFactor);
      this.pixels[index + DEPRESSION] = depression;
      this.pixels[index + BERM] = berm;
      if (depression === 0) {
        this.pixels[index + GRADIENT_X] = NEUTRAL_GRADIENT;
        this.pixels[index + GRADIENT_Z] = NEUTRAL_GRADIENT;
      } else {
        this.pixels[index + GRADIENT_X] = Math.round(
          NEUTRAL_GRADIENT + (this.pixels[index + GRADIENT_X] - NEUTRAL_GRADIENT) * depressionFactor,
        );
        this.pixels[index + GRADIENT_Z] = Math.round(
          NEUTRAL_GRADIENT + (this.pixels[index + GRADIENT_Z] - NEUTRAL_GRADIENT) * depressionFactor,
        );
      }
      peak = Math.max(peak, depression, berm);
      if (depression === 0 && berm === 0) this.occupied.delete(index);
    }
    this.peak = peak;
    return true;
  }

  #scrollPixels(shiftX, shiftY) {
    this.#clear(this.scrollPixels);
    let peak = 0;
    const occupied = new Set();
    for (const source of this.occupied) {
      const pixel = source / CHANNELS;
      const x = pixel % this.config.resolution - shiftX;
      const y = Math.floor(pixel / this.config.resolution) - shiftY;
      if (x < 0 || x >= this.config.resolution || y < 0 || y >= this.config.resolution) continue;
      const target = (y * this.config.resolution + x) * CHANNELS;
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        this.scrollPixels[target + channel] = this.pixels[source + channel];
      }
      occupied.add(target);
      peak = Math.max(peak, this.pixels[source + DEPRESSION], this.pixels[source + BERM]);
    }
    this.occupied = occupied;
    this.pixels.set(this.scrollPixels);
    this.peak = peak;
    if (peak === 0) this.recoveryElapsed = 0;
    this.texture.needsUpdate = true;
  }

  #clear(buffer) {
    buffer.fill(0);
    for (let index = 0; index < buffer.length; index += CHANNELS) {
      buffer[index + GRADIENT_X] = NEUTRAL_GRADIENT;
      buffer[index + GRADIENT_Z] = NEUTRAL_GRADIENT;
    }
  }

  clear() {
    this.occupied.clear();
    this.lastRecoveryPixels = 0;
    this.#clear(this.pixels);
    this.peak = 0;
    this.recoveryElapsed = 0;
    this.lastContacts.length = 0;
    this.texture.needsUpdate = true;
  }

  sampleAt(x, z) {
    if (!this.centerInitialized) return emptySample();
    const u = (x - this.center.x) / this.config.worldSize + 0.5;
    const v = (z - this.center.y) / this.config.worldSize + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return emptySample();
    const px = Math.min(this.config.resolution - 1, Math.floor(u * this.config.resolution));
    const py = Math.min(this.config.resolution - 1, Math.floor(v * this.config.resolution));
    const offset = (py * this.config.resolution + px) * CHANNELS;
    return {
      depression: this.pixels[offset + DEPRESSION] / BYTE_MAX,
      berm: this.pixels[offset + BERM] / BYTE_MAX,
      gradientX: (this.pixels[offset + GRADIENT_X] - NEUTRAL_GRADIENT) / 127,
      gradientZ: (this.pixels[offset + GRADIENT_Z] - NEUTRAL_GRADIENT) / 127,
    };
  }

  dispose() {
    this.texture.dispose();
  }
}
