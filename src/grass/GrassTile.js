import * as THREE from 'three';

export class GrassTile {
  constructor(scene, material, geometry) {
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
    this.mesh.position.set(x, 0, z);
    this.mesh.userData.tileX = tileX;
    this.mesh.userData.tileZ = tileZ;
  }

  setGeometry(geometry, lodName) {
    if (this.mesh.geometry === geometry) return;
    this.mesh.geometry = geometry;
    this.mesh.userData.currentLOD = lodName;
  }

  setVisible(visible) {
    this.mesh.visible = visible;
  }

  dispose(scene) {
    scene.remove(this.mesh);
  }
}
