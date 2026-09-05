import * as THREE from 'three';
import { compactGrassGeometry } from './compactGrassGeometry.js';

export class GrassTile {
  constructor(scene, material, geometry, cinematic = false) {
    this.scene = scene;
    this.cinematic = cinematic;
    this.cache = new Map();
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'GrassTile';
    this.mesh.userData.excludeFromReflection = true;
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
    if (this.mesh.position.x !== x || this.mesh.position.z !== z) this.invalidate();
    this.mesh.position.set(x, 0, z);
    this.mesh.userData.tileX = tileX;
    this.mesh.userData.tileZ = tileZ;
  }

  setGeometry(source, lodName, containsGrass) {
    let geometry = source;
    if (this.cinematic && containsGrass) {
      if (!this.cache.has(source)) {
        this.cache.set(source, compactGrassGeometry(source, this.mesh.position.x, this.mesh.position.z, containsGrass));
      }
      geometry = this.cache.get(source);
    }
    this.mesh.geometry = geometry;
    this.mesh.userData.currentLOD = lodName;
  }

  setVisible(visible) {
    this.mesh.visible = visible;
  }

  invalidate() {
    for (const geometry of this.cache.values()) geometry.dispose();
    this.cache.clear();
  }

  dispose(scene) {
    this.invalidate();
    scene.remove(this.mesh);
  }
}
