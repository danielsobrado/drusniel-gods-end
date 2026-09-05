import * as THREE from 'three';
import { createSeededRandom } from '../core/math.js';

export class GrassField {
  constructor(scene, config) {
    this.config = config;
    this.random = createSeededRandom(config.seed);
    this.baseTransforms = [];
    this.dummy = new THREE.Object3D();

    const geometry = new THREE.PlaneGeometry(config.bladeWidth, config.bladeHeight, 1, 1);
    geometry.translate(0, config.bladeHeight / 2, 0);
    const material = new THREE.MeshStandardMaterial({
      color: config.baseColor,
      roughness: 0.92,
      side: THREE.DoubleSide,
      vertexColors: true,
    });

    this.mesh = new THREE.InstancedMesh(geometry, material, config.count);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#populate();
    scene.add(this.mesh);
  }

  #populate() {
    const color = new THREE.Color();
    const base = new THREE.Color(this.config.baseColor);
    const tip = new THREE.Color(this.config.tipColor);

    for (let index = 0; index < this.config.count; index += 1) {
      const angle = this.random() * Math.PI * 2;
      const radius = Math.sqrt(this.random()) * this.config.radius;
      const scale = 1 - this.config.heightVariation / 2 + this.random() * this.config.heightVariation;
      const transform = {
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius,
        yaw: this.random() * Math.PI,
        scale,
        phase: this.random() * Math.PI * 2,
      };
      this.baseTransforms.push(transform);
      this.#writeMatrix(index, transform, 0);
      color.copy(base).lerp(tip, this.random() * 0.6);
      this.mesh.setColorAt(index, color);
    }

    this.mesh.instanceColor.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  #writeMatrix(index, transform, sway) {
    this.dummy.position.set(transform.x, 0, transform.z);
    this.dummy.rotation.set(sway, transform.yaw, sway * 0.35);
    this.dummy.scale.set(1, transform.scale, 1);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(index, this.dummy.matrix);
  }

  update(elapsedSeconds) {
    const strength = this.config.windStrength;
    const speed = this.config.simulationSpeed;
    for (let index = 0; index < this.baseTransforms.length; index += 1) {
      const transform = this.baseTransforms[index];
      const sway = Math.sin(elapsedSeconds * speed + transform.phase + transform.x * 0.025) * strength;
      this.#writeMatrix(index, transform, sway);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
  }
}
