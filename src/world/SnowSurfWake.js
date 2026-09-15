import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { resolveSnowWakeConfig } from '../config/resolveSnowWakeConfig.js';
import { sampleSnowSurfaceCpu } from './SnowDeformationField.js';
import { createSnowWakeMaterial } from './SnowWakeMaterial.js';
import { SPINE_ROWS, SnowWakeSpine, readPackedSpine } from './snowWakeSpine.js';
import { wakeCrestParameter, wakePointCpu } from './snowWakeProfile.js';

const SURF_ENTER_RATE = 2.6;
const SURF_EXIT_RATE = 3.4;
const SURF_EPSILON = 0.01;
const CARVE_RATE = 9;
const SURFACE_NORMAL_STEP = 0.5;
const CURTAIN_SHARE = 0.72;
const CLOD_SHARE = 0.35;
const _cameraAxis = new THREE.Vector3();

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function expDamp(current, target, rate, delta) {
  return target + (current - target) * Math.exp(-rate * delta);
}

function range(min, max) {
  return min + (max - min) * Math.random();
}

function createWakeLatticeGeometry(columns, rows) {
  const perSide = columns * (rows + 1);
  const vertexCount = perSide * 2;
  const lattice = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array((columns - 1) * rows * 12);
  let vertex = 0;
  let cursor = 0;
  for (const side of [-1, 1]) {
    const base = vertex;
    for (let column = 0; column < columns; column += 1) {
      for (let row = 0; row <= rows; row += 1) {
        lattice[vertex * 3] = column / (columns - 1);
        lattice[vertex * 3 + 1] = row / rows;
        lattice[vertex * 3 + 2] = side;
        normals[vertex * 3 + 1] = 1;
        vertex += 1;
      }
    }
    for (let column = 0; column < columns - 1; column += 1) {
      for (let row = 0; row < rows; row += 1) {
        const a = base + column * (rows + 1) + row;
        const b = a + rows + 1;
        indices.set([a, b, a + 1, a + 1, b, b + 1], cursor);
        cursor += 6;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('wake', new THREE.BufferAttribute(lattice, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

// Snow-surf wake: a swept mesh along the path the rider has taken, two spray
// populations thrown off its crest, and the speed streak and camera shake
// signals that go with a loaded edge. Surfing is sprinting on snow.
export class SnowSurfWake {
  constructor({ scene, camera, terrainSampler, config, powder = null }) {
    this.config = resolveSnowWakeConfig(config.ground.snow.wake);
    this.rootConfig = config;
    this.camera = camera;
    this.terrainSampler = terrainSampler;
    this.powder = powder;
    this.clock = 0;
    this.surf = 0;
    this.carve = 0;
    this.previousYaw = null;
    this.trauma = 0;
    this.streak = 0;
    this.sprayOwed = 0;
    this.driftOwed = 0;
    this.shakeOffset = new THREE.Vector3();
    this.sample = {};
    this.crest = {};
    this.layout = null;
    if (!this.config.enabled) return;

    const { capacity, columns, rows, spineStep } = this.config;
    this.spine = new SnowWakeSpine(capacity);
    this.data = new Float32Array(capacity * SPINE_ROWS * 4);
    this.texture = new THREE.DataTexture(this.data, capacity, SPINE_ROWS, THREE.RGBAFormat, THREE.FloatType);
    this.texture.name = 'SnowWakeSpine';
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    this.uniforms = {
      entries: uniform(1),
      bowGap: uniform(0),
      step: uniform(spineStep),
      length: uniform(0),
      scale: uniform(1),
    };
    this.geometry = createWakeLatticeGeometry(columns, rows);
    this.material = createSnowWakeMaterial({
      spineTexture: this.texture,
      uniforms: this.uniforms,
      columns,
      rows,
      settings: this.config,
      snow: config.ground.snow,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'SnowSurfWake';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.mesh.userData.excludeFromReflection = true;
    scene.add(this.mesh);
  }

  // Undo last frame's shake before the player camera follows, so the follow
  // spring never integrates the jitter.
  restoreCamera() {
    if (this.shakeOffset.lengthSq() === 0) return;
    this.camera.position.sub(this.shakeOffset);
    this.shakeOffset.set(0, 0, 0);
  }

  update(deltaSeconds, player, grounded) {
    if (!this.config.enabled || !player) return;
    const delta = clamp(Number(deltaSeconds) || 0, 0, 0.1);
    if (delta === 0) return;
    this.clock += delta;
    const settings = this.config;
    const scale = player.modelHeight > 0 ? player.modelHeight / settings.referenceHeight : 1;
    const position = player.getPosition();
    const speed = Number(player.speed) || 0;
    const surface = grounded
      ? sampleSnowSurfaceCpu(this.terrainSampler, position.x, position.z, SURFACE_NORMAL_STEP * scale, this.rootConfig)
      : null;
    const coverage = surface ? clamp(surface.coverage, 0, 1) : 0;
    const surfing = Boolean(grounded && player.running && coverage >= settings.minCoverage
      && speed >= settings.minSpeed * scale);
    this.surf = expDamp(this.surf, surfing ? 1 : 0, surfing ? SURF_ENTER_RATE : SURF_EXIT_RATE, delta);
    const speedRatio = speed / (settings.fullSpeed * scale);
    const speed01 = clamp(speedRatio, 0, 1);

    // Lateral acceleration is speed times yaw rate. Yaw grows turning left, so
    // a right turn gives positive carve and loads the left (outside) wall.
    const yaw = Number(player.playerYaw) || 0;
    const turn = this.previousYaw === null ? 0 : Math.atan2(Math.sin(yaw - this.previousYaw), Math.cos(yaw - this.previousYaw));
    this.previousYaw = yaw;
    const lateral = -speed * turn / delta;
    const leanWant = clamp(lateral / (settings.carveAcceleration * scale), -1, 1) * (0.35 + 0.65 * this.surf);
    this.carve = expDamp(this.carve, leanWant, CARVE_RATE, delta);

    const velocity = player.horizontalVelocity;
    const forwardX = speed > 0.05 && velocity ? velocity.x / speed : Math.sin(yaw);
    const forwardZ = speed > 0.05 && velocity ? velocity.z / speed : Math.cos(yaw);
    const rightX = -forwardZ;
    const rightZ = forwardX;
    const live = this.surf > SURF_EPSILON;
    const strength = live ? this.surf * speed01 * coverage : 0;
    const groundY = surface?.y ?? position.y - (player.metrics?.rootToFeet ?? 0);
    const step = settings.spineStep * scale;

    if (live) this.spine.update(this.clock, position.x, groundY, position.z, rightX, rightZ, strength, this.carve, step);
    this.layout = this.spine.pack(this.data, {
      clock: this.clock,
      bowX: position.x + forwardX * settings.bowLead * scale,
      bowY: groundY,
      bowZ: position.z + forwardZ * settings.bowLead * scale,
      rightX,
      rightZ,
      strength,
      carve: this.carve,
      life: settings.lifeSeconds,
      maxHeight: settings.maxHeight * scale,
      scale,
      step,
    });
    this.#updateCameraShake(delta, scale, speed01);
    this.streak = settings.streaks.strength * this.surf * clamp(
      (speedRatio - settings.streaks.startSpeedRatio)
        / (settings.streaks.fullSpeedRatio - settings.streaks.startSpeedRatio),
      0,
      1,
    );

    if (!live && !this.layout.live) {
      this.spine.reset();
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.uniforms.entries.value = this.layout.entries;
    this.uniforms.bowGap.value = this.layout.bowGap;
    this.uniforms.step.value = step;
    this.uniforms.length.value = this.layout.length;
    this.uniforms.scale.value = scale;
    this.texture.needsUpdate = true;
    if (strength > 0) this.#emitSpray(delta, speed, scale, strength, forwardX, forwardZ);
  }

  #emitSpray(delta, speed, scale, strength, forwardX, forwardZ) {
    if (!this.powder?.config.enabled || this.layout.length <= 0) return;
    const { spray, halfWidth } = this.config;
    // Owed in reference metres of loaded wall, so a larger rider throws the
    // same amount of snow per body length rather than per world metre.
    const travelled = speed * delta / scale * strength;
    this.sprayOwed += travelled * spray.curtainPerMetre;
    this.driftOwed += travelled * spray.driftPerMetre;
    const sprayCount = Math.floor(this.sprayOwed);
    const driftCount = Math.floor(this.driftOwed);
    this.sprayOwed -= sprayCount;
    this.driftOwed -= driftCount;
    const budget = spray.maxPerFrame;
    // Velocities follow Froude scaling so arcs keep their shape at any size.
    const speedScale = Math.sqrt(scale);
    const boardX = forwardX * speed;
    const boardZ = forwardZ * speed;

    for (let index = 0; index < Math.min(sprayCount, budget); index += 1) {
      const sample = readPackedSpine(this.data, this.config.capacity, this.layout,
        Math.min(this.layout.length, scale * range(0.6, 2.4)), this.sample);
      const total = sample.ampL + sample.ampR;
      if (total <= 1e-3) continue;
      const side = Math.random() * total < sample.ampL ? -1 : 1;
      const curl = side > 0 ? sample.curlR : sample.curlL;
      const curtain = Math.random() < CURTAIN_SHARE;
      const crestQ = wakeCrestParameter(curl);
      const crest = wakePointCpu(sample, curtain ? crestQ * range(0.85, 1) : crestQ, side, scale, halfWidth, this.crest);
      if (curtain) {
        // Dense slow sheet hugging the crest.
        const outward = range(0.4, 1.4) * speedScale;
        this.powder.emit(
          crest.x, crest.y, crest.z,
          crest.outwardX * outward + boardX * 0.25,
          range(0.8, 2) * speedScale,
          crest.outwardZ * outward + boardZ * 0.25,
          range(0.03, 0.08) * scale,
          range(0.34, 0.74),
          4.5,
        );
        continue;
      }
      // Ballistic grains and clods flung clear of the wall.
      const clod = Math.random() < CLOD_SHARE;
      const outward = range(2.2, 4.6) * speedScale;
      this.powder.emit(
        crest.x, crest.y, crest.z,
        crest.outwardX * outward + boardX * 0.45,
        range(2.4, 4.8) * speedScale,
        crest.outwardZ * outward + boardZ * 0.45,
        (clod ? range(0.02, 0.042) : range(0.025, 0.055)) * scale,
        clod ? range(0.7, 1.2) : range(0.9, 2.2),
        clod ? 0.7 : range(1, 1.8),
      );
    }

    for (let index = 0; index < Math.min(driftCount, budget); index += 1) {
      const sample = readPackedSpine(this.data, this.config.capacity, this.layout,
        Math.min(this.layout.length, scale * range(0, 3)), this.sample);
      const lateral = range(-1, 1) * halfWidth * scale;
      this.powder.emit(
        sample.x + sample.rightX * lateral,
        sample.y + 0.05 * scale,
        sample.z + sample.rightZ * lateral,
        boardX * 0.15,
        range(0.3, 0.9) * speedScale,
        boardZ * 0.15,
        range(0.05, 0.12) * scale,
        range(0.6, 1.2),
        6,
      );
    }
  }

  #updateCameraShake(delta, scale, speed01) {
    const { amplitude, loadThreshold, gain, decay } = this.config.shake;
    const load = Math.abs(this.carve) * speed01 * this.surf;
    if (load > loadThreshold) this.trauma = Math.min(1, this.trauma + (load - loadThreshold) * gain * delta);
    this.trauma = Math.max(0, this.trauma - decay * delta);
    const magnitude = amplitude * scale * this.trauma * this.trauma;
    if (magnitude <= 0) return;
    const t = this.clock;
    const x = (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 23.3 + 1.7) * 0.4) * magnitude;
    const y = (Math.sin(t * 31.7 + 0.4) * 0.6 + Math.sin(t * 19.1 + 2.3) * 0.4) * magnitude;
    this.restoreCamera();
    this.shakeOffset.copy(_cameraAxis.set(1, 0, 0).applyQuaternion(this.camera.quaternion)).multiplyScalar(x);
    this.shakeOffset.addScaledVector(_cameraAxis.set(0, 1, 0).applyQuaternion(this.camera.quaternion), y);
    this.camera.position.add(this.shakeOffset);
  }

  dispose() {
    this.restoreCamera();
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
