import * as THREE from 'three';

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

function unitNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${name} must be in [0, 1].`);
  return number;
}

export function resolveSnowDeformationConfig(config) {
  if (!config) throw new Error('ground.snow.deformation configuration is required.');
  const resolution = Math.round(positiveNumber(config.resolution, 'ground.snow.deformation.resolution'));
  return {
    enabled: config.enabled !== false,
    resolution,
    worldSize: positiveNumber(config.worldSize, 'ground.snow.deformation.worldSize'),
    paintMinCoverage: unitNumber(config.paintMinCoverage, 'ground.snow.deformation.paintMinCoverage'),
    footRadiusScale: positiveNumber(config.footRadiusScale, 'ground.snow.deformation.footRadiusScale'),
    depressionStrength: unitNumber(config.depressionStrength, 'ground.snow.deformation.depressionStrength'),
    bermStrength: unitNumber(config.bermStrength, 'ground.snow.deformation.bermStrength'),
    decaySeconds: positiveNumber(config.decaySeconds, 'ground.snow.deformation.decaySeconds'),
    bermDecaySeconds: positiveNumber(config.bermDecaySeconds, 'ground.snow.deformation.bermDecaySeconds'),
    recoveryInterval: positiveNumber(config.recoveryInterval, 'ground.snow.deformation.recoveryInterval'),
  };
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
  const slope = THREE.MathUtils.smoothstep(Math.abs(normalY), snow.slope.start, snow.slope.full);
  return THREE.MathUtils.clamp(altitude * slope, 0, 1);
}

export class SnowDeformationField {
  constructor(config, terrainSampler) {
    this.config = resolveSnowDeformationConfig(config.ground.snow.deformation);
    this.rootConfig = config;
    this.terrainSampler = terrainSampler;
    this.center = new THREE.Vector2();
    this.lastCenter = new THREE.Vector2(Number.NaN, Number.NaN);
    this.nextCenter = new THREE.Vector2();
    this.recoveryElapsed = 0;
    this.peak = 0;
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
    const next = this.nextCenter.set(playerPosition.x, playerPosition.z);
    if (!Number.isFinite(this.lastCenter.x)) {
      this.lastCenter.copy(next);
      this.center.copy(next);
    }
    this.#scroll(next.x - this.lastCenter.x, next.y - this.lastCenter.y);
    this.lastCenter.copy(next);
    this.center.copy(next);

    let changed = this.#recover(deltaSeconds);
    if (moving) {
      const points = influencePoints.length > 0
        ? influencePoints
        : [{ position: playerPosition, radius: this.config.worldSize / this.config.resolution * 2 }];
      for (const point of points) changed = this.#paintPoint(point) || changed;
    }
    if (changed) this.texture.needsUpdate = true;
  }

  #paintPoint(point) {
    const position = point?.position;
    if (!position) return false;
    const x = position.x;
    const z = position.z;
    const terrainHeight = this.terrainSampler.sampleHeight(x, z);
    const step = Math.max(0.4, this.config.worldSize / this.config.resolution * 2);
    const dx = this.terrainSampler.sampleHeight(x + step, z) - this.terrainSampler.sampleHeight(x - step, z);
    const dz = this.terrainSampler.sampleHeight(x, z + step) - this.terrainSampler.sampleHeight(x, z - step);
    const normalY = 1 / Math.sqrt(1 + (dx / (step * 2)) ** 2 + (dz / (step * 2)) ** 2);
    const coverage = sampleSnowCoverageCpu(x, terrainHeight, z, normalY, this.rootConfig);
    if (coverage < this.config.paintMinCoverage) return false;

    const radius = Math.max(MIN_RADIUS, Number(point.radius) * this.config.footRadiusScale);
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
            const directionScale = distance > MIN_RADIUS ? Math.min(1, falloff * 1.4) : 0;
            this.pixels[offset + GRADIENT_X] = Math.round(NEUTRAL_GRADIENT + vx * directionScale * 127);
            this.pixels[offset + GRADIENT_Z] = Math.round(NEUTRAL_GRADIENT + vz * directionScale * 127);
            this.peak = Math.max(this.peak, depression);
            changed = true;
          }
          continue;
        }

        const ring = Math.max(0, 1 - Math.abs(distance - 1.22) / 0.33);
        const berm = Math.round(BYTE_MAX * this.config.bermStrength * coverage * ring);
        if (berm > this.pixels[offset + BERM]) {
          this.pixels[offset + BERM] = berm;
          this.peak = Math.max(this.peak, berm);
          changed = true;
        }
      }
    }
    return changed;
  }

  #recover(deltaSeconds) {
    if (this.peak === 0) return false;
    this.recoveryElapsed += Math.max(0, deltaSeconds);
    if (this.recoveryElapsed < this.config.recoveryInterval) return false;
    const elapsed = this.recoveryElapsed;
    this.recoveryElapsed = 0;
    const depressionFactor = Math.exp(-elapsed / this.config.decaySeconds);
    const bermFactor = Math.exp(-elapsed / this.config.bermDecaySeconds);
    let peak = 0;
    for (let index = 0; index < this.pixels.length; index += CHANNELS) {
      const depression = Math.floor(this.pixels[index + DEPRESSION] * depressionFactor);
      const berm = Math.floor(this.pixels[index + BERM] * bermFactor);
      this.pixels[index + DEPRESSION] = depression;
      this.pixels[index + BERM] = berm;
      this.pixels[index + GRADIENT_X] = Math.round(
        NEUTRAL_GRADIENT + (this.pixels[index + GRADIENT_X] - NEUTRAL_GRADIENT) * depressionFactor,
      );
      this.pixels[index + GRADIENT_Z] = Math.round(
        NEUTRAL_GRADIENT + (this.pixels[index + GRADIENT_Z] - NEUTRAL_GRADIENT) * depressionFactor,
      );
      peak = Math.max(peak, depression, berm);
    }
    this.peak = peak;
    return true;
  }

  #scroll(deltaX, deltaZ) {
    if (this.peak === 0) return;
    const pixelsPerUnit = this.config.resolution / this.config.worldSize;
    const shiftX = Math.trunc(deltaX * pixelsPerUnit);
    const shiftY = Math.trunc(deltaZ * pixelsPerUnit);
    if (shiftX === 0 && shiftY === 0) return;
    if (Math.abs(shiftX) >= this.config.resolution || Math.abs(shiftY) >= this.config.resolution) {
      this.clear();
      return;
    }

    this.#clear(this.scrollPixels);
    for (let y = 0; y < this.config.resolution; y += 1) {
      const sourceY = y + shiftY;
      if (sourceY < 0 || sourceY >= this.config.resolution) continue;
      for (let x = 0; x < this.config.resolution; x += 1) {
        const sourceX = x + shiftX;
        if (sourceX < 0 || sourceX >= this.config.resolution) continue;
        const target = (y * this.config.resolution + x) * CHANNELS;
        const source = (sourceY * this.config.resolution + sourceX) * CHANNELS;
        this.scrollPixels[target] = this.pixels[source];
        this.scrollPixels[target + 1] = this.pixels[source + 1];
        this.scrollPixels[target + 2] = this.pixels[source + 2];
        this.scrollPixels[target + 3] = this.pixels[source + 3];
      }
    }
    this.pixels.set(this.scrollPixels);
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
    this.#clear(this.pixels);
    this.peak = 0;
    this.recoveryElapsed = 0;
    this.texture.needsUpdate = true;
  }

  sampleAt(x, z) {
    const u = THREE.MathUtils.clamp((x - this.center.x) / this.config.worldSize + 0.5, 0, 1);
    const v = THREE.MathUtils.clamp((z - this.center.y) / this.config.worldSize + 0.5, 0, 1);
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
