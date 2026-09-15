import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { resolveSnowWakeConfig } from '../config/resolveSnowWakeConfig.js';
import { sampleSnowSurfaceCpu } from './SnowDeformationField.js';
import { createSnowWakeMaterial } from './SnowWakeMaterial.js';
import { getSnowTextures } from './snowTextures.js';
import { SPINE_ROWS, SnowWakeSpine, readPackedSpine } from './snowWakeSpine.js';
import { wakeBaseOffset } from './snowWakeProfile.js';

const SURF_ENTER_RATE = 2.6;
const SURF_EXIT_RATE = 3.4;
const CARVE_RATE = 9;
const SURFACE_NORMAL_STEP = 0.5;
// Snowflow's gates and spans, in reference units.
const ACTIVE_SURF = 0.06;
const ACTIVE_SPEED = 1.6;
const RESTART_SECONDS = 0.25;
const VISIBLE_AMPLITUDE = 0.01;
const PLUME_MIN_SURF = 0.15;
const PLUME_MIN_SPEED = 3;
const PLUME_SPAN = 15;
const DRIFT_SPAN = 22;
const DRIFT_MAX_PER_FRAME = 14;
const CURTAIN_SHARE = 0.72;
const CLOD_SHARE = 0.18;
const _cameraAxis = new THREE.Vector3();

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function expDamp(current, target, rate, delta) {
  return target + (current - target) * Math.exp(-rate * delta);
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

// Snow-surf wake after Snowflow's surfWake.js (MIT, Maksymilian Dendura): a
// swept mesh along the path the rider has taken, two spray populations thrown
// off its crest, and the speed streak and camera shake signals that go with a
// loaded edge. Surfing is sprinting on snow.
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
    this.active = false;
    this.previousYaw = null;
    this.trauma = 0;
    this.streak = 0;
    this.sprayOwed = 0;
    this.driftOwed = 0;
    this.shakeOffset = new THREE.Vector3();
    this.sample = {};
    this.layout = { count: 0, maxAmp: 0 };
    if (!this.config.enabled) return;

    const { capacity, columns, rows } = this.config;
    this.spine = new SnowWakeSpine(capacity);
    this.data = new Float32Array(capacity * SPINE_ROWS * 4);
    this.texture = new THREE.DataTexture(this.data, capacity, SPINE_ROWS, THREE.RGBAFormat, THREE.FloatType);
    this.texture.name = 'SnowWakeSpine';
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    this.uniforms = { count: uniform(0), scale: uniform(1) };
    this.geometry = createWakeLatticeGeometry(columns, rows);
    this.material = createSnowWakeMaterial({
      spineTexture: this.texture,
      uniforms: this.uniforms,
      columns,
      rows,
      settings: this.config,
      snow: config.ground.snow,
      textures: getSnowTextures(config),
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
    const turn = this.previousYaw === null
      ? 0
      : Math.atan2(Math.sin(yaw - this.previousYaw), Math.cos(yaw - this.previousYaw));
    this.previousYaw = yaw;
    const leanWant = clamp(-speed * turn / delta / (settings.carveAcceleration * scale), -1, 1)
      * (0.35 + 0.65 * this.surf);
    this.carve = expDamp(this.carve, leanWant, CARVE_RATE, delta);

    const velocity = player.horizontalVelocity;
    const forwardX = speed > 0.05 && velocity ? velocity.x / speed : Math.sin(yaw);
    const forwardZ = speed > 0.05 && velocity ? velocity.z / speed : Math.cos(yaw);
    const rightX = -forwardZ;
    const rightZ = forwardX;
    const strength = this.surf * speed01 * coverage;
    const groundY = surface?.y ?? position.y - (player.metrics?.rootToFeet ?? 0);

    // A new run starts a new spine: reconnecting would sweep a wall across
    // whatever ground lies between where the rider stopped and restarted.
    const active = this.surf > ACTIVE_SURF && speed / scale > ACTIVE_SPEED;
    if (active) {
      if (!this.active && this.spine.count > 0
        && this.clock - this.spine.laid[this.spine.head] > RESTART_SECONDS) this.spine.reset();
      this.spine.update(this.clock, position.x, groundY, position.z, rightX, rightZ, strength, this.carve,
        settings.spineStep * scale);
    }
    this.active = active;

    this.layout = this.spine.pack(this.data, {
      clock: this.clock,
      bowX: position.x + forwardX * settings.bowLead * scale,
      bowY: groundY,
      bowZ: position.z + forwardZ * settings.bowLead * scale,
      rightX,
      rightZ,
      strength: active ? strength : 0,
      carve: this.carve,
      life: settings.lifeSeconds,
      maxHeight: settings.maxHeight * scale,
      scale,
    });
    this.#updateCameraShake(delta, scale, speed01);
    this.streak = settings.streaks.strength * this.surf * clamp(
      (speedRatio - settings.streaks.startSpeedRatio)
        / (settings.streaks.fullSpeedRatio - settings.streaks.startSpeedRatio),
      0,
      1,
    );

    const visible = this.layout.count >= 2 && this.layout.maxAmp > VISIBLE_AMPLITUDE * scale;
    this.mesh.visible = visible;
    if (visible) {
      this.uniforms.count.value = this.layout.count;
      this.uniforms.scale.value = scale;
      this.texture.needsUpdate = true;
    }
    this.#emitSpray(delta, speed, scale, velocity);
  }

  // Spray off the lip, emitted from the crest band the mesh draws. Rate is per
  // metre travelled, so it does not thin out at a higher frame rate.
  #emitSpray(delta, speed, scale, velocity) {
    const powder = this.powder;
    const count = this.layout.count;
    if (!powder?.config.enabled || count < 3 || this.surf < PLUME_MIN_SURF || speed / scale < PLUME_MIN_SPEED) {
      this.sprayOwed = 0;
      return;
    }
    const { spray, capacity } = this.config;
    const travelled = speed * delta / scale;
    this.sprayOwed += travelled;
    this.driftOwed += travelled;
    // Froude scaling: arcs keep their shape for a larger rider.
    const speedScale = Math.sqrt(scale);
    // Snowflow sizes are billboard radii; the powder pool takes diameters.
    const diameter = 2 * scale;
    const boardX = velocity?.x ?? 0;
    const boardZ = velocity?.z ?? 0;

    let plume = Math.floor(this.sprayOwed * spray.curtainPerMetre);
    if (plume > 0) {
      this.sprayOwed -= plume / spray.curtainPerMetre;
      plume = Math.min(plume, spray.maxPerFrame);
      // Fractional positions over the live front of the wave, from the bow, so
      // the plume is a continuous line rather than a row of clumps.
      const span = Math.min(count - 1, PLUME_SPAN);
      for (let index = 0; index < plume; index += 1) {
        const sample = readPackedSpine(this.data, capacity, count, Math.random() * span, this.sample);
        const total = sample.ampL + sample.ampR;
        if (total < 0.12 * scale) continue;
        const side = Math.random() * total < sample.ampL ? -1 : 1;
        const amplitude = side < 0 ? sample.ampL : sample.ampR;
        if (amplitude < 0.1 * scale) continue;
        const rightLength = Math.hypot(sample.rightX, sample.rightZ) || 1;
        const rx = sample.rightX / rightLength;
        const rz = sample.rightZ / rightLength;
        const fx = rz;
        const fz = -rx;
        // A band straddling the crest's lateral maximum, weighted toward the lip.
        const lateral = scale * wakeBaseOffset(sample.distance / scale) + (0.35 + Math.random() * 0.55) * amplitude;
        const px = sample.x + rx * side * lateral;
        const py = sample.y + (0.3 + 0.82 * Math.sqrt(Math.random())) * amplitude;
        const pz = sample.z + rz * side * lateral;

        if (Math.random() < CURTAIN_SHARE) {
          // Curtain: big, slow, short-lived, high drag.
          const outward = (0.4 + Math.random() * 1.1) * speedScale;
          powder.emit(
            px, py, pz,
            rx * side * outward + boardX * 0.16,
            (0.9 + Math.random() * 1.8) * speedScale,
            rz * side * outward + boardZ * 0.16,
            (0.055 + Math.random() * 0.085) * diameter,
            0.34 + Math.random() * 0.4,
            4.5,
          );
          continue;
        }
        // Throw: ballistic grains and clods that actually clear the wave.
        const outward = (1.2 + Math.random() * 2.6) * speedScale;
        const back = (0.4 + Math.random() * 2.2) * speedScale;
        const clod = Math.random() < CLOD_SHARE;
        powder.emit(
          px, py, pz,
          rx * side * outward - fx * back + boardX * 0.3,
          (1.6 + Math.random() * 3.4 + amplitude / scale * 1.5) * speedScale,
          rz * side * outward - fz * back + boardZ * 0.3,
          (clod ? 0.02 + Math.random() * 0.022 : 0.045 + Math.random() * 0.055) * diameter,
          clod ? 0.7 + Math.random() * 0.5 : 0.9 + Math.random() * 1.3,
          clod ? 0.7 : 1 + Math.random() * 0.8,
        );
      }
    }

    // A slower stream of fine powder hanging low over the trench, so the trail
    // still looks like it is smoking after the lip spray has landed.
    let drift = Math.floor(this.driftOwed * spray.driftPerMetre);
    const driftSpan = Math.min(count - 3, DRIFT_SPAN);
    if (drift > 0 && driftSpan > 0) {
      this.driftOwed -= drift / spray.driftPerMetre;
      drift = Math.min(drift, DRIFT_MAX_PER_FRAME);
      for (let index = 0; index < drift; index += 1) {
        const sample = readPackedSpine(this.data, capacity, count, 2 + Math.random() * driftSpan, this.sample);
        const rightLength = Math.hypot(sample.rightX, sample.rightZ) || 1;
        const lateral = (Math.random() - 0.5) * 1.6 * scale / rightLength;
        powder.emit(
          sample.x + sample.rightX * lateral,
          sample.y + (0.08 + Math.random() * 0.35) * scale,
          sample.z + sample.rightZ * lateral,
          (Math.random() - 0.5) * 1.1 * speedScale,
          (0.25 + Math.random() * 0.9) * speedScale,
          (Math.random() - 0.5) * 1.1 * speedScale,
          (0.026 + Math.random() * 0.036) * diameter,
          1.5 + Math.random() * 1.6,
          4.5,
        );
      }
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
