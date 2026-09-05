import * as THREE from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { createRandom } from '../utils/random.js';
import { logger } from '../utils/logger.js';

const TWO_PI = Math.PI * 2;

function createFallbackBird() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0x1f2422, roughness: 0.8 });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.8, 0, 0,
    0, 0.22, 0,
    0.8, 0, 0,
  ], 3));
  geometry.setIndex([0, 1, 2]);
  group.add(new THREE.Mesh(geometry, material));
  return group;
}

export class BirdSystem {
  constructor({ scene, terrainRoot, clips = [], terrainSampler, config }) {
    this.scene = scene;
    this.config = config;
    this.clips = clips;
    this.bounds = terrainSampler?.bounds ?? null;
    this.random = createRandom(config.birds.randomSeed ?? 1234);
    this.entries = [];
    this.source = terrainRoot?.getObjectByName(config.birds.sourceName) ?? null;
    this.orbitCenter = config.birds.orbitCenter
      ? new THREE.Vector3().fromArray(config.birds.orbitCenter)
      : null;

    for (let index = 0; index < config.birds.count; index += 1) this.#createBird();
    if (!this.source) logger.warn('Bird source was not found in the terrain GLB; using procedural bird silhouettes.');
  }

  #randomRange(min, max) {
    return min + this.random() * (max - min);
  }

  #createCenter() {
    if (this.orbitCenter) return this.orbitCenter.clone();
    if (!this.bounds) return new THREE.Vector3();

    const padding = this.config.birds.edgePadding;
    return new THREE.Vector3(
      this.#randomRange(this.bounds.min.x + padding, this.bounds.max.x - padding),
      0,
      this.#randomRange(this.bounds.min.z + padding, this.bounds.max.z - padding),
    );
  }

  #createBird() {
    const bird = this.source ? clone(this.source) : createFallbackBird();
    bird.visible = true;

    const group = new THREE.Group();
    const center = this.#createCenter();
    group.position.copy(center);

    const radius = this.#randomRange(this.config.birds.minOrbitRadius, this.config.birds.maxOrbitRadius);
    const angle = this.#randomRange(0, TWO_PI);
    const speed = this.#randomRange(this.config.birds.minSpeed, this.config.birds.maxSpeed);
    const height = this.#randomRange(this.config.birds.minHeight, this.config.birds.maxHeight);
    const scale = this.#randomRange(this.config.birds.minScale, this.config.birds.maxScale);
    const direction = this.random() > 0.5 ? 1 : -1;
    const bobOffset = this.#randomRange(0, TWO_PI);

    bird.position.set(radius, height, 0);
    bird.scale.setScalar(scale);
    group.add(bird);
    this.scene.add(group);

    const mixer = this.source && this.clips.length > 0 ? new THREE.AnimationMixer(bird) : null;
    const action = mixer ? mixer.clipAction(this.clips[0]) : null;
    action?.play();

    this.entries.push({
      group,
      bird,
      mixer,
      action,
      center,
      radius,
      angle,
      speed,
      height,
      scale,
      direction,
      bobOffset,
    });
  }

  playAnimation(index = 0, fadeSeconds = 0.2) {
    const clip = this.clips[index];
    if (!clip) return;

    for (const entry of this.entries) {
      if (!entry.mixer) continue;
      const next = entry.mixer.clipAction(clip);
      next.reset();
      next.play();
      entry.action?.crossFadeTo(next, fadeSeconds, true);
      entry.action = next;
    }
  }

  update(deltaSeconds) {
    for (const entry of this.entries) {
      entry.mixer?.update(deltaSeconds);
      entry.angle += entry.speed * entry.direction * deltaSeconds;
      entry.group.rotation.y = entry.angle;
      entry.bird.position.y = entry.height
        + Math.sin(entry.angle + entry.bobOffset) * this.config.birds.bobAmount;
    }
  }

  dispose() {
    for (const entry of this.entries) {
      entry.mixer?.stopAllAction();
      this.scene.remove(entry.group);
    }
    this.entries.length = 0;
  }
}
