import * as THREE from 'three';
import { compactGrassGeometry } from './compactGrassGeometry.js';

export class GrassTile {
  constructor(scene, material, geometry, cinematic = false) {
    this.scene = scene;
    this.cinematic = cinematic;
    this.cache = new Map();
    this.valid = new Set();
    this.staging = new Map();
    this.layoutRevision = 0;
    this.stagingRevision = -1;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'GrassTile';
    this.mesh.userData.excludeFromReflection = true;
    this.mesh.userData.occlusionBounds = new THREE.Box3();
    this.mesh.frustumCulled = false;
    // The tile only moves in setPosition(), which recomposes the local matrix
    // itself; skipping auto-update saves a compose per tile per render pass.
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.userData.currentLOD = 'veryLow';
    this.mesh.userData.tileX = 0;
    this.mesh.userData.tileZ = 0;
    // Maintained by GrassField (tile repositioning and remapEmptyTiles): true
    // when the tile lies outside the terrain or in the empty-tile set.
    this.isEmpty = false;
    scene.add(this.mesh);
  }

  setPosition(x, z, tileX, tileZ) {
    if (this.mesh.position.x !== x || this.mesh.position.z !== z) {
      this.valid.clear();
      this.discardStaging();
    }
    this.mesh.position.set(x, 0, z);
    this.mesh.updateMatrix();
    this.mesh.userData.tileX = tileX;
    this.mesh.userData.tileZ = tileZ;
  }

  setGeometry(source, lodName, containsGrass, layoutRevision = 0) {
    if (this.layoutRevision !== layoutRevision) {
      this.valid.clear();
      this.discardStaging();
      this.layoutRevision = layoutRevision;
    }
    let geometry = source;
    let compacted = false;
    if (this.cinematic && containsGrass) {
      if (!this.valid.has(source)) {
        const started = performance.now();
        this.cache.set(source, compactGrassGeometry(source, this.mesh.position.x, this.mesh.position.z,
          containsGrass, this.cache.get(source)));
        this.valid.add(source);
        this.lastCompactionMs = performance.now() - started;
        compacted = true;
      }
      geometry = this.cache.get(source);
    }
    this.mesh.geometry = geometry;
    this.mesh.userData.currentLOD = lodName;
    return compacted;
  }

  setVisible(visible) {
    this.mesh.visible = visible;
  }

  stageGeometry(source, lodName, containsGrass, layoutRevision = 0) {
    if (this.stagingRevision !== layoutRevision) {
      this.#disposeMap(this.staging);
      this.stagingRevision = layoutRevision;
    }
    let compacted = false;
    if (this.cinematic && containsGrass && !this.staging.has(source)) {
      const started = performance.now();
      this.staging.set(source, compactGrassGeometry(source, this.mesh.position.x, this.mesh.position.z, containsGrass));
      this.lastCompactionMs = performance.now() - started;
      compacted = true;
    }
    this.stagedLod = lodName;
    return compacted;
  }

  commitStaged(layoutRevision) {
    if (this.stagingRevision !== layoutRevision) return;
    this.#disposeMap(this.cache);
    this.cache = this.staging;
    this.staging = new Map();
    this.valid = new Set(this.cache.keys());
    this.layoutRevision = layoutRevision;
    if (this.stagedLod) this.mesh.userData.currentLOD = this.stagedLod;
    const source = [...this.cache.values()].at(-1);
    if (source) this.mesh.geometry = source;
  }

  discardStaging() {
    this.#disposeMap(this.staging);
    this.stagingRevision = -1;
  }

  #disposeMap(map) {
    for (const geometry of map.values()) geometry.dispose();
    map.clear();
  }

  invalidate() {
    this.valid.clear();
    this.#disposeMap(this.cache);
    this.discardStaging();
  }

  dispose(scene) {
    this.invalidate();
    scene.remove(this.mesh);
  }
}
