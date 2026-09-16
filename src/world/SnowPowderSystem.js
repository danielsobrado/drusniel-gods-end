import * as THREE from 'three/webgpu';
import {
  atan, cameraViewMatrix, dot, float, fract, instanceIndex, normalize, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { resolveSnowPowderConfig } from '../config/resolveSnowPowderConfig.js';
import { resolveCoastConfig } from './CoastField.js';
import { foliageLight } from '../rendering/CinematicLighting.js';
import { noise2 } from './snowNoiseNodes.js';
import { sampleSurfaceCpu } from './SnowDeformationField.js';
import { advanceSnowPowderVelocity, snowWindVector } from './SnowPowderPhysics.js';

const UINT32_MAX_PLUS_ONE = 4294967296;
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const AMBIENT_MAX_EMISSIONS_PER_FRAME = 8;
const AMBIENT_HORIZONTAL_JITTER = 0.35;
const AMBIENT_INITIAL_WIND_FACTOR = 0.25;

const MIE_G = 0.55;
// Brightest foliageLight.strength; lighting is expressed relative to it.
const FULL_SUN_STRENGTH = 0.8;

// Airborne snow shaded after Snowflow's spray.fragment.wgsl (MIT, Maksymilian
// Dendura). The billboard is lit as a sphere, so a puff has a lit and a dark
// side, and looking toward the sun through it adds a strong warm forward-scatter
// lobe: the difference between spray catching the light and grey smoke. The
// disc edge is wobbled per particle so puffs are not perfect circles.
function createPowderMaterial(config) {
  const corner = uv().sub(0.5).mul(2);
  const radius2 = dot(corner, corner);
  const seed = fract(float(instanceIndex).mul(0.618034));
  const angle = atan(corner.y, corner.x);
  const wobble = noise2(vec2(angle.cos(), angle.sin()).mul(2.4).add(seed.mul(37))).mul(0.34).add(1);
  const radius = radius2.sqrt().div(wobble);
  const edge = radius.mul(radius).oneMinus().clamp(0, 1).pow(1.6);

  // Billboards face the camera, so the sphere normal is built in view space.
  const normalView = normalize(vec3(corner.x, corner.y, radius2.oneMinus().max(0).sqrt()));
  const lightView = normalize(cameraViewMatrix.mul(vec4(foliageLight.direction, 0)).xyz);
  const sun = foliageLight.color.mul(foliageLight.strength.div(FULL_SUN_STRENGTH));
  const diffuse = dot(normalView, lightView).add(0.75).div(1.75 * 1.75).max(0).div(1 / 1.75);
  // Cornette-Shanks phase; mu is 1 looking straight into the sun.
  const mu = lightView.z.negate();
  const g2 = MIE_G * MIE_G;
  const phase = mu.mul(mu).add(1).mul((3 / (8 * Math.PI)) * (1 - g2) / (2 + g2))
    .div(mu.mul(-2 * MIE_G).add(1 + g2).pow(1.5));
  const sky = vec3(0.56, 0.64, 0.76);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  material.name = 'SnowPowder';
  // Albedo comes from the per-instance colour: snow or kicked sand.
  material.colorNode = vec3(1)
    .mul(sky.add(sun.mul(diffuse).mul(0.55)).add(sun.mul(phase).mul(0.85 * Math.PI * 0.35)));
  material.opacityNode = edge.mul(config.opacity);
  return material;
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
    this.ambientAccumulator = 0;
    const wind = snowWindVector(config.ground.snow.wind.angleDegrees, this.config.windSpeed);
    this.physics = {
      windX: wind.x,
      windZ: wind.z,
      drag: this.config.drag,
      gravity: this.config.gravity,
      terminalFallSpeed: this.config.terminalFallSpeed,
    };

    const capacity = this.config.capacity;
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.ages = new Float32Array(capacity);
    this.lifetimes = new Float32Array(capacity);
    this.sizes = new Float32Array(capacity);
    this.drags = new Float32Array(capacity);
    this.active = new Uint8Array(capacity);
    this.dummy = new THREE.Object3D();
    this.snowColor = new THREE.Color(this.config.color);
    // Dry beach sand kicks up through the same pool; see water.sea.coast.sand.
    const sea = config.water?.sea?.enabled ? resolveCoastConfig(config.water.sea) : null;
    this.sand = sea?.coast.sand ?? null;
    this.sandColor = new THREE.Color(this.sand?.kickColor ?? this.config.color);
    this.colorsDirty = false;

    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.material = createPowderMaterial(this.config);
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

  update(deltaSeconds, focusPosition, influencePoints = [], moving = false, running = false) {
    if (!this.config.enabled) return;
    const delta = Math.min(Math.max(Number(deltaSeconds) || 0, 0), 0.1);
    this.#advance(delta);
    if (this.config.ambient.enabled && focusPosition) this.#emitAmbient(delta, focusPosition);
    if (moving) this.#emitFromContacts(influencePoints, running);
    else this.lastContacts.length = 0;
    this.#syncInstances();
  }

  #emitAmbient(delta, focusPosition) {
    this.ambientAccumulator += delta * this.config.ambient.particlesPerSecond;
    const count = Math.min(Math.floor(this.ambientAccumulator), AMBIENT_MAX_EMISSIONS_PER_FRAME);
    this.ambientAccumulator -= count;
    for (let index = 0; index < count; index += 1) this.#spawnAmbient(focusPosition);
  }

  #spawnAmbient(focusPosition) {
    const angle = this.#random() * Math.PI * 2;
    const radius = Math.sqrt(this.#random()) * this.config.ambient.radius;
    const x = Number(focusPosition.x) + Math.cos(angle) * radius;
    const z = Number(focusPosition.z) + Math.sin(angle) * radius;
    const surface = this.#sampleSurface(x, z);
    if (!surface || surface.snow < this.config.minCoverage) return;

    const position = {
      x,
      y: surface.y + this.#range(this.config.ambient.height.min, this.config.ambient.height.max),
      z,
    };
    const velocity = {
      x: this.physics.windX * AMBIENT_INITIAL_WIND_FACTOR
        + this.#range(-AMBIENT_HORIZONTAL_JITTER, AMBIENT_HORIZONTAL_JITTER),
      y: this.#range(this.config.ambient.verticalSpeed.min, this.config.ambient.verticalSpeed.max),
      z: this.physics.windZ * AMBIENT_INITIAL_WIND_FACTOR
        + this.#range(-AMBIENT_HORIZONTAL_JITTER, AMBIENT_HORIZONTAL_JITTER),
    };
    this.#spawnParticle(
      position,
      velocity,
      this.#range(this.config.ambient.size.min, this.config.ambient.size.max),
      this.#range(this.config.ambient.lifetime.min, this.config.ambient.lifetime.max),
    );
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
      const multiplier = (running ? this.config.runningMultiplier : 1)
        * (contact.sand ? this.sand.kickMultiplier : 1);
      const count = Math.max(1, Math.round(this.config.particlesPerContact * multiplier * contact.coverage));
      for (let i = 0; i < count; i += 1) this.#spawnContact(contact);
    }
    if (this.lastContacts.length > points.length) this.lastContacts.length = points.length;
  }

  #contact(point) {
    const position = point?.position;
    if (!position) return null;
    const x = Number(position.x);
    const z = Number(position.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const surface = this.#sampleSurface(x, z);
    if (!surface) return null;
    const drySand = this.sand ? surface.sand * surface.sandDryness : 0;
    const sand = surface.snow < this.config.minCoverage;
    const coverage = sand ? drySand : surface.snow;
    if (coverage < this.config.minCoverage) return null;
    const radius = Number.isFinite(Number(point.radius)) && Number(point.radius) > 0 ? Number(point.radius) : 0;
    if (Number.isFinite(Number(position.y))) {
      const y = Number(position.y);
      if (y - radius > surface.y + this.config.contactHeight
        || y + radius < surface.y - this.config.contactHeight) return null;
    }
    return { x, y: surface.y + this.config.spawnHeight, z, coverage, sand };
  }

  #sampleSurface(x, z) {
    return sampleSurfaceCpu(this.terrainSampler, x, z, this.config.normalSampleDistance, this.rootConfig);
  }

  // Emits one particle from another system (the surf wake), with its own drag
  // so a slow crest curtain and ballistic grains share the pool. `size` is the
  // billboard diameter in metres.
  emit(x, y, z, vx, vy, vz, size, lifetime, drag = this.config.drag) {
    if (!this.config.enabled) return;
    this.#spawnParticle({ x, y, z }, { x: vx, y: vy, z: vz }, size, lifetime, drag);
  }

  #spawnContact(contact) {
    const angle = this.#random() * Math.PI * 2;
    const radial = Math.sqrt(this.#random()) * this.config.spread;
    const speed = this.#range(this.config.horizontalSpeed.min, this.config.horizontalSpeed.max);
    const velocityAngle = angle + (this.#random() - 0.5) * Math.PI;
    // Sand is heavier than powder snow: a lower, shorter-lived kick.
    const lift = contact.sand ? this.sand.kickLift : 1;
    const life = contact.sand ? this.sand.kickLifetime : 1;
    this.#spawnParticle(
      {
        x: contact.x + Math.cos(angle) * radial,
        y: contact.y + this.#random() * this.config.spawnHeight,
        z: contact.z + Math.sin(angle) * radial,
      },
      {
        x: Math.cos(velocityAngle) * speed,
        y: this.#range(this.config.verticalSpeed.min, this.config.verticalSpeed.max) * lift,
        z: Math.sin(velocityAngle) * speed,
      },
      this.#range(this.config.size.min, this.config.size.max),
      this.#range(this.config.lifetime.min, this.config.lifetime.max) * life,
      this.config.drag,
      contact.sand ? this.sandColor : this.snowColor,
    );
  }

  #spawnParticle(position, velocity, size, lifetime, drag = this.config.drag, tint = this.snowColor) {
    if (this.tints?.[this.cursor] !== tint) {
      this.tints ??= [];
      this.tints[this.cursor] = tint;
      this.mesh.setColorAt(this.cursor, tint);
      this.colorsDirty = true;
    }
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.config.capacity;
    if (!this.active[index]) this.activeCount += 1;
    this.active[index] = 1;
    this.ages[index] = 0;
    this.lifetimes[index] = lifetime;
    this.sizes[index] = size;
    this.drags[index] = drag;
    const offset = index * 3;
    this.positions[offset] = position.x;
    this.positions[offset + 1] = position.y;
    this.positions[offset + 2] = position.z;
    this.velocities[offset] = velocity.x;
    this.velocities[offset + 1] = velocity.y;
    this.velocities[offset + 2] = velocity.z;
  }

  #advance(delta) {
    if (delta <= 0 || this.activeCount === 0) return;
    for (let index = 0; index < this.config.capacity; index += 1) {
      if (!this.active[index]) continue;
      this.ages[index] += delta;
      if (this.ages[index] >= this.lifetimes[index]) {
        this.active[index] = 0;
        this.activeCount -= 1;
        continue;
      }
      const offset = index * 3;
      this.physics.drag = this.drags[index];
      advanceSnowPowderVelocity(this.velocities, offset, delta, this.physics);
      this.positions[offset] += this.velocities[offset] * delta;
      this.positions[offset + 1] += this.velocities[offset + 1] * delta;
      this.positions[offset + 2] += this.velocities[offset + 2] * delta;

      const ground = this.terrainSampler.sampleHeight(this.positions[offset], this.positions[offset + 2]);
      if (Number.isFinite(ground) && this.positions[offset + 1] < ground) {
        this.positions[offset + 1] = ground;
        this.velocities[offset] *= this.config.settleHorizontalRetention;
        this.velocities[offset + 1] = 0;
        this.velocities[offset + 2] *= this.config.settleHorizontalRetention;
        this.ages[index] += delta * this.config.settleFadeMultiplier;
      }
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
    if (this.colorsDirty) {
      this.mesh.instanceColor.needsUpdate = true;
      this.colorsDirty = false;
    }
  }

  #hideAllInstances() {
    this.dummy.position.set(0, -10000, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    this.tints = new Array(this.config.capacity).fill(this.snowColor);
    for (let index = 0; index < this.config.capacity; index += 1) {
      this.mesh.setMatrixAt(index, this.dummy.matrix);
      this.mesh.setColorAt(index, this.snowColor);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
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
  }
}
