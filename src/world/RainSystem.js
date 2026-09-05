import * as THREE from 'three';
import { createSeededRandom } from '../core/math.js';

const RAIN_SEED = 90210;

export class RainSystem {
  constructor(scene, config) {
    this.config = config;
    this.enabled = false;
    this.positions = new Float32Array(config.count * 3);
    const random = createSeededRandom(RAIN_SEED);

    for (let index = 0; index < config.count; index += 1) {
      const offset = index * 3;
      this.positions[offset] = (random() - 0.5) * config.radius * 2;
      this.positions[offset + 1] = random() * config.height;
      this.positions[offset + 2] = (random() - 0.5) * config.radius * 2;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const material = new THREE.PointsMaterial({
      color: config.color,
      size: 0.055,
      transparent: true,
      opacity: config.opacity,
      depthWrite: false,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.visible = false;
    scene.add(this.points);
  }

  setIntensity(value) {
    this.enabled = value > 0;
    this.points.visible = this.enabled;
    this.points.material.opacity = this.config.opacity * value;
  }

  update(deltaSeconds, center) {
    if (!this.enabled) return;
    const radius = this.config.radius;
    const height = this.config.height;
    for (let index = 0; index < this.config.count; index += 1) {
      const offset = index * 3;
      this.positions[offset + 1] -= this.config.speed * deltaSeconds;
      if (this.positions[offset + 1] < 0) this.positions[offset + 1] += height;
    }
    this.points.position.set(center.x, 0, center.z);
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.frustumCulled = false;
    this.points.scale.set(1, 1, Math.max(0.4, radius / 30));
  }

  dispose() {
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.points.removeFromParent();
  }
}
