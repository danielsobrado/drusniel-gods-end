import * as THREE from 'three/webgpu';
import {
  attribute, cameraPosition, cameraWorldMatrix, color, dot, float, mix, normalize, positionGeometry, positionWorld,
  smoothstep, texture, uv,
} from 'three/tsl';
import { adoptInstanceMatrices } from '../rendering/instanceMatrices.js';
import { SKY_GAIN } from '../water/sceneLight.js';

// Puff slots; each breath takes a few, so this allows two to three breaths
// in the air at once.
const SLOTS = 16;
// Human-scale reference; the character's size scales everything.
const REFERENCE_HEIGHT = 1.8;
const EXHALE_SECONDS = 0.35;
const DRAG = 1.6;
const HEAD_PATTERN = /(^|[^a-z])head$/i;

/**
 * Condensed breath from the player's mouth in cold air. A handful of CPU
 * particles: unlike the GPU fields they must stay where they were exhaled
 * while the character walks on, so they are integrated here and uploaded as
 * one small instanced attribute a frame. Hidden, and free, off the snow.
 */
export class BreathPuffs {
  constructor({ settings, light, puffTexture }) {
    this.settings = settings;
    this.intensity = 0;
    this.timer = 0;
    this.pending = 0;
    this.emitClock = 0;
    this.next = 0;
    this.lastMouth = null;
    this.mouthPosition = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.puffs = Array.from({ length: SLOTS }, () => ({ age: Infinity, life: 1, position: new THREE.Vector3(),
      velocity: new THREE.Vector3(), seed: Math.random() }));
    this.state = new Float32Array(SLOTS * 4);
    this.shape = new Float32Array(SLOTS * 2);
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.stateAttribute = new THREE.InstancedBufferAttribute(this.state, 4);
    this.shapeAttribute = new THREE.InstancedBufferAttribute(this.shape, 2);
    this.stateAttribute.setUsage(THREE.DynamicDrawUsage);
    this.shapeAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('breathState', this.stateAttribute);
    this.geometry.setAttribute('breathShape', this.shapeAttribute);
    this.material = this.#createMaterial(light, puffTexture);
    this.mesh = adoptInstanceMatrices(new THREE.InstancedMesh(this.geometry, this.material, SLOTS));
    this.mesh.name = 'Ambient breath';
    const identity = new THREE.Matrix4();
    for (let index = 0; index < SLOTS; index += 1) this.mesh.setMatrixAt(index, identity);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.userData.excludeFromReflection = true;
    this.mesh.userData.occlusionCull = false;
    this.head = null;
    this.headModel = null;
  }

  #createMaterial(light, puffTexture) {
    // breathState: position xyz and size; breathShape: opacity and variant.
    const state = attribute('breathState', 'vec4');
    const shape = attribute('breathShape', 'vec2');
    const right = cameraWorldMatrix.element(0).xyz;
    const up = cameraWorldMatrix.element(1).xyz;
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    material.name = 'Ambient breath';
    material.fog = true;
    material.positionNode = state.xyz.add(right.mul(positionGeometry.x.mul(state.w)))
      .add(up.mul(positionGeometry.y.mul(state.w)));
    const sample = texture(puffTexture, uv());
    const variant = shape.y.mul(4).floor();
    const density = variant.lessThan(1).select(sample.r, variant.lessThan(2).select(sample.g,
      variant.lessThan(3).select(sample.b, sample.a)));
    const near = smoothstep(0.4, 1.4, cameraPosition.distance(positionWorld));
    material.opacityNode = density.mul(shape.x).mul(near).mul(float(this.settings.opacity));
    const mu = dot(normalize(positionWorld.sub(cameraPosition)), light.direction);
    const backlit = mu.max(0).pow(4);
    material.colorNode = color('#f2f6fa').mul(light.sun.mul(mix(float(0.35), float(1.6), backlit))
      .add(light.sky.mul(SKY_GAIN)));
    return material;
  }

  // The head bone's world position, or a point above the character's root.
  #mouth(model, modelHeight, yaw, target) {
    if (model !== this.headModel) {
      this.headModel = model;
      this.head = null;
      model?.traverse((object) => {
        if (!this.head && object.isBone && HEAD_PATTERN.test(object.name)) this.head = object;
      });
    }
    const scale = modelHeight / REFERENCE_HEIGHT;
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    if (this.head) {
      this.head.getWorldPosition(target);
      target.x += forwardX * 0.12 * scale;
      target.z += forwardZ * 0.12 * scale;
      target.y -= 0.06 * scale;
    } else if (model) {
      model.getWorldPosition(target);
      target.x += forwardX * 0.12 * scale;
      target.z += forwardZ * 0.12 * scale;
      target.y += modelHeight * 0.9;
    }
    return target;
  }

  /**
   * `weight` is 0..1 (cold enough to see breath); `player` supplies the
   * character model, its height, facing and whether it runs.
   */
  update(delta, weight, player) {
    this.intensity = weight;
    const model = player?.getCharacterModel?.();
    const modelHeight = player?.modelHeight > 0 ? player.modelHeight : REFERENCE_HEIGHT;
    const scale = modelHeight / REFERENCE_HEIGHT;
    const s = this.settings;
    let alive = 0;
    if (model && weight > 0) {
      const mouth = this.#mouth(model, modelHeight, player.playerYaw ?? 0, this.mouthPosition);
      if (this.lastMouth && delta > 0) {
        this.velocity.subVectors(mouth, this.lastMouth).divideScalar(delta);
        // A teleport is not a velocity.
        if (this.velocity.lengthSq() > 900 * scale * scale) this.velocity.set(0, 0, 0);
      }
      (this.lastMouth ??= new THREE.Vector3()).copy(mouth);
      const period = player.running ? s.runningPeriod : s.period;
      this.timer += delta;
      if (this.timer >= period) {
        this.timer %= period;
        this.pending = s.puffsPerBreath;
        this.emitClock = 0;
      }
      // The puffs of one breath leave over the exhale, not all at once.
      this.emitClock += delta;
      const interval = EXHALE_SECONDS / s.puffsPerBreath;
      while (this.pending > 0 && this.emitClock >= 0) {
        this.#emit(mouth, player.playerYaw ?? 0, scale);
        this.pending -= 1;
        this.emitClock -= interval;
      }
    } else {
      this.lastMouth = null;
    }
    const damping = Math.exp(-DRAG * delta);
    for (let index = 0; index < SLOTS; index += 1) {
      const puff = this.puffs[index];
      puff.age += delta;
      const t = puff.age / puff.life;
      if (t < 1) {
        alive += 1;
        puff.velocity.multiplyScalar(damping);
        puff.velocity.y += 0.12 * scale * delta;
        puff.position.addScaledVector(puff.velocity, delta);
        const size = THREE.MathUtils.lerp(s.size[0], s.size[1], Math.sqrt(t)) * scale;
        const envelope = THREE.MathUtils.smoothstep(t, 0, 0.12) * (1 - THREE.MathUtils.smoothstep(t, 0.35, 1));
        this.state.set([puff.position.x, puff.position.y, puff.position.z, size], index * 4);
        this.shape[index * 2] = envelope * this.intensity;
        this.shape[index * 2 + 1] = puff.seed;
      } else {
        this.state[index * 4 + 3] = 0;
        this.shape[index * 2] = 0;
      }
    }
    this.mesh.visible = alive > 0;
    if (alive > 0) {
      this.stateAttribute.needsUpdate = true;
      this.shapeAttribute.needsUpdate = true;
    }
  }

  #emit(mouth, yaw, scale) {
    const puff = this.puffs[this.next];
    this.next = (this.next + 1) % SLOTS;
    const speed = this.settings.speed * scale * (0.75 + Math.random() * 0.5);
    puff.age = 0;
    puff.life = this.settings.lifetime * (0.8 + Math.random() * 0.4);
    puff.seed = Math.random();
    puff.position.copy(mouth);
    puff.velocity.set(Math.sin(yaw) * speed, -0.15 * speed, Math.cos(yaw) * speed)
      .addScaledVector(this.velocity, 0.85);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
