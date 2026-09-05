import * as THREE from 'three';

export class GrassTile {
  constructor(scene, material, geometry, cinematic = false) {
    this.scene = scene;
    this.cinematic = cinematic;
    this.previous = null;
    this.transition = 1;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.userData.currentLOD = 'veryLow';
    this.mesh.userData.tileX = 0;
    this.mesh.userData.tileZ = 0;
    // Set by GrassField.remapEmptyTiles(); false until then, matching the
    // previous "key absent from the emptyTiles set means visible" behavior.
    this.isEmpty = false;
    scene.add(this.mesh);
  }

  setPosition(x, z, tileX, tileZ) {
    if (this.mesh.position.x !== x || this.mesh.position.z !== z) this.#finishTransition();
    this.mesh.position.set(x, 0, z);
    this.mesh.userData.tileX = tileX;
    this.mesh.userData.tileZ = tileZ;
  }

  setGeometry(geometry, lodName) {
    if (this.mesh.geometry === geometry) return;
    this.#finishTransition();
    if (this.cinematic && this.mesh.visible) {
      this.previous = new THREE.Mesh(this.mesh.geometry, this.mesh.material);
      this.previous.position.copy(this.mesh.position);
      this.previous.frustumCulled = false;
      this.previous.receiveShadow = true;
      this.previous.userData.lodFade = 1;
      this.scene.add(this.previous);
      this.transition = 0;
      this.mesh.userData.lodFade = 0;
    }
    this.mesh.geometry = geometry;
    this.mesh.userData.currentLOD = lodName;
  }

  setVisible(visible) {
    this.mesh.visible = visible;
    if (!visible) this.#finishTransition();
  }

  update(delta) {
    if (!this.previous) return;
    this.transition = Math.min(1, this.transition + delta / 0.35);
    this.mesh.userData.lodFade = this.transition;
    this.previous.userData.lodFade = 1 - this.transition;
    if (this.transition === 1) this.#finishTransition();
  }

  #finishTransition() {
    this.previous?.removeFromParent();
    this.previous = null;
    this.transition = 1;
    this.mesh.userData.lodFade = 1;
  }

  dispose(scene) {
    this.#finishTransition();
    scene.remove(this.mesh);
  }
}
