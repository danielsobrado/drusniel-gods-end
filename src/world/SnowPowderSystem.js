import * as THREE from 'three/webgpu';
import { resolveSnowPowderConfig } from '../config/resolveSnowPowderConfig.js';
import { sampleSnowCoverageCpu } from './SnowDeformationField.js';

const UINT32_MAX_PLUS_ONE = 4294967296;
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;

function createPowderTexture(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Snow powder canvas context is unavailable.');
  const center = size * 0.5;
  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.72)');
  gradient.addColorStop(0.72, 'rgba(255,255,255,0.18)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function smoothFade(value, start) {
  if (value <= start) return 1;
  const t = Math.min(1, (value - start) / Math.max(1 - start, Number.EPSILON));
  return 1 - t * t * (3 - 2 * t);
}

export class SnowPowderSystem {
  constructor({ scene, camera, terrainSampler, config }) {
    this.scene = scene;
    this.camera = camera;
    this.terrainSampler = terrainSampler;
    this.rootConfig = config;
    this.config = resolveSnowPowderConfig(config.ground.snow.powder);
    this.randomState = this.config.seed || 1;
    this.cursor = 0;
    this.activeCount = 0;
    this.lastContacts = [];
    const capacity = this.config.capacity;
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.ages = new Float32Array(capacity);
    this.lifetimes = new Float32Array(capacity);
    this.sizes = new Float32Array(capacity);
    this.active = new Uint8Array(capacity);
    this.dummy = new THREE.Object3D();

    this.texture = createPowderTexture(this.config.textureSize);
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(this.config.color),
      map: this.texture,
      transparent: true,
      opacity: this.config.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.name = 'SnowPowder';
    this.mesh.count = capacity;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.userData.excludeFromReflection = true;
    this.#hideAllInstances();
    scene.add(this.mesh);
  }

  update(deltaSeconds, playerPosition, influencePoints = [], moving = false, running = false) {
    if (!this.config.enabled) return;
    const delta = Math.min(Math.max(Number(deltaSeconds) || 0, 0), 0.1);
    this.#advance(delta);
    if (moving && playerPosition) this.#emitFromContacts(influencePoints, running);
    else this.lastContacts.length = 0;
    this.#syncInstances();
  }

  #emitFromContacts(points, running) {
    for (let index = 0; index < points.length; index += 1) {
      const contact = this.#contact(points[index]);
      if (!contact) {
        this.lastContacts[index] = null;
        continue;
      }
      const previous = this.lastContacts[index];
      const moved = previous ? Math.hypot(contact.x - previous.x, contact.z - previous.z) : this.config.emitDistance;
      if (moved < this.config.emitDistance) continue;
      this.lastContacts[index] = { x: contact.x, z: contact.z };
      const multiplier = running ? this.config.runningMultiplier : 1;
      const count = Math.max(1, Math.round(this.config.particlesPerContact * multiplier * contact.coverage));
      for (let i = 0; i < count; i += 1) this.#spawn(contact);
    }
    if (this.lastContacts.length > points.length) this.lastContacts.length = points.length;
  }

  #contact(point) {
    const position = point?.position;
    if (!position) return null;
    const x = Number(position.x);
    const z = Number(position.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const terrainHeight = this.terrainSampler.sampleHeight(x, z);
    if (!Number.isFinite(terrainHeight)) return null;
    const radius = Number.isFinite(Number(point.radius)) && Number(point.radius) > 0 ? Number(point.radius) : 0;
    if (Number.isFinite(Number(position.y))) {
      const y = Number(position.y);
      if (y - radius > terrainHeight + this.config.contactHeight
        || y + radius < terrainHeight - this.config.contactHeight) return null;
    }
    const step = this.config.normalSampleDistance;
    const dx = this.terrainSampler.sampleHeight(x + step, z) - this.terrainSampler.sampleHeight(x - step, z);
    const dz = this.terrainSampler.sampleHeight(x, z + step) - this.terrainSampler.sampleHeight(x, z - step);
    const normalY = 1 / Math.sqrt(1 + (dx / (step * 2)) ** 2 + (dz / (step * 2)) ** 2);
    const coverage = sampleSnowCoverageCpu(x, terrainHeight, z, normalY, this.rootConfig);
    if (coverage < this.config.minCoverage) return null;
    return { x, y: terrainHeight + this.config.spawnHeight, z, coverage };
  }

  #spawn(contact) {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.config.capacity;
    if (!this.active[index]) this.activeCount += 1;
    this.active[index] = 1;
    this.ages[index] = 0;
    this.lifetimes[index] = this.#range(this.config.lifetime.min, this.config.lifetime.max);
    this.sizes[index] = this.#range(this.config.size.min, this.config.size.max);

    const angle = this.#random() * Math.PI * 2;
    const radial = Math.sqrt(this.#random()) * this.config.spread;
    const positionOffset = index * 3;
    this.positions[positionOffset] = contact.x + Math.cos(angle) * radial;
    this.positions[positionOffset + 1] = contact.y + this.#random() * this.config.spawnHeight;
    this.positions[positionOffset + 2] = contact.z + Math.sin(angle) * radial;

    const speed = this.#range(this.config.horizontalSpeed.min, this.config.horizontalSpeed.max);
    const velocityAngle = angle + (this.#random() - 0.5) * Math.PI;
    this.velocities[positionOffset] = Math.cos(velocityAngle) * speed;
    this.velocities[positionOffset + 1] = this.#range(this.config.verticalSpeed.min, this.config.verticalSpeed.max);
    this.velocities[positionOffset + 2] = Math.sin(velocityAngle) * speed;
  }

  #advance(delta) {
    if (delta <= 0 || this.activeCount === 0) return;
    const drag = Math.exp(-this.config.drag * delta);
    for (let index = 0; index < this.config.capacity; index += 1) {
      if (!this.active[index]) continue;
      this.ages[index] += delta;
      if (this.ages[index] >= this.lifetimes[index]) {
        this.active[index] = 0;
        this.activeCount -= 1;
        continue;
      }
      const offset = index * 3;
      this.velocities[offset] *= drag;
      this.velocities[offset + 2] *= drag;
      this.velocities[offset + 1] -= this.config.gravity * delta;
      this.positions[offset] += this.velocities[offset] * delta;
      this.positions[offset + 1] += this.velocities[offset + 1] * delta;
      this.positions[offset + 2] += this.velocities[offset + 2] * delta;
    }
  }

  #syncInstances() {
    if (this.activeCount === 0) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.dummy.quaternion.copy(this.camera.quaternion);
    for (let index = 0; index < this.config.capacity; index += 1) {
      const offset = index * 3;
      if (!this.active[index]) {
        this.dummy.position.set(0, -10000, 0);
        this.dummy.scale.setScalar(0);
      } else {
        const progress = this.ages[index] / this.lifetimes[index];
        const fade = smoothFade(progress, this.config.fadeStart);
        const size = this.sizes[index] * (1 + progress * this.config.sizeGrowth) * fade;
        this.dummy.position.set(
          this.positions[offset],
          this.positions[offset + 1],
          this.positions[offset + 2],
        );
        this.dummy.scale.setScalar(size);
      }
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(index, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  #hideAllInstances() {
    this.dummy.position.set(0, -10000, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let index = 0; index < this.config.capacity; index += 1) {
      this.mesh.setMatrixAt(index, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  #random() {
    this.randomState = (Math.imul(this.randomState, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    return this.randomState / UINT32_MAX_PLUS_ONE;
  }

  #range(min, max) {
    return min + (max - min) * this.#random();
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
