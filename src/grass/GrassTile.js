import * as THREE from 'three';
import { compactGrassGeometry, releaseCompactionScratch } from './compactGrassGeometry.js';

export class GrassTile {
  // `attach` false keeps the mesh out of the scene: near grass draws through
  // GrassBatches and the tile only compacts and holds its blades.
  constructor(scene, material, geometry, cinematic = false, attach = true) {
    this.scene = scene;
    this.cinematic = cinematic;
    this.cache = new Map();
    this.valid = new Set();
    this.staging = new Map();
    this.compactionJobs = new Map();
    this.generation = 0;
    this.disposed = false;
    this.layoutRevision = 0;
    this.requestedRevision = 0;
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
    if (attach) scene.add(this.mesh);
  }

  setPosition(x, z, tileX, tileZ) {
    if (this.mesh.position.x !== x || this.mesh.position.z !== z) {
      this.cancelCompactions();
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
      this.cancelCompactions();
      this.valid.clear();
      this.discardStaging();
      this.layoutRevision = layoutRevision;
      this.requestedRevision = layoutRevision;
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

  cancelCompactions() {
    this.generation += 1;
    for (const { jobs, id } of this.compactionJobs.values()) jobs.cancel(id);
    this.compactionJobs.clear();
  }

  hasValidGeometry(revision) {
    if (!this.cinematic) return !this.disposed;
    if (this.layoutRevision !== revision) return false;
    for (const source of this.valid) if (this.cache.get(source) === this.mesh.geometry) return true;
    return false;
  }

  commitCompacted(source, geometry, lodName, revision) {
    if (this.disposed || geometry.userData.compactDone !== true) return false;
    if (this.layoutRevision !== revision) {
      this.valid.clear();
      this.layoutRevision = revision;
    }
    const previous = this.cache.get(source);
    if (previous && previous !== geometry) {
      // Publish into the existing GPU attribute identities. Swapping a fresh
      // geometry on every recycled tile would reintroduce allocation/upload
      // stalls despite the CPU compaction itself being time-sliced.
      for (const name of ['instancePosition', 'instanceRotation', 'instanceData']) {
        const input = geometry.getAttribute(name), output = previous.getAttribute(name);
        const length = geometry.instanceCount * output.itemSize;
        output.array.set(input.array.subarray(0, length));
        output.clearUpdateRanges();
        if (length) { output.addUpdateRange(0, length); output.needsUpdate = true; }
      }
      previous.instanceCount = geometry.instanceCount;
      Object.assign(previous.userData, geometry.userData);
      releaseCompactionScratch(source, geometry);
      geometry = previous;
    }
    this.cache.set(source, geometry);
    this.valid.add(source);
    if (this.requestedSource === source || this.mesh.geometry === previous || !this.hasValidGeometry(revision)) {
      this.mesh.geometry = geometry;
      this.mesh.userData.currentLOD = lodName;
    }
    return true;
  }

  stageGeometry(source, lodName, containsGrass, layoutRevision = 0, options = {}) {
    if (this.stagingRevision !== layoutRevision) {
      this.#disposeMap(this.staging);
      this.stagingRevision = layoutRevision;
    }
    let compacted = false;
    if (this.cinematic && containsGrass) {
      const existing = this.staging.get(source);
      if (!existing || existing.userData.compactDone === false) {
        const started = performance.now();
        this.staging.set(source, compactGrassGeometry(
          source, this.mesh.position.x, this.mesh.position.z, containsGrass, existing,
          options,
        ));
        this.lastCompactionMs = performance.now() - started;
        compacted = true;
      }
    }
    this.stagedLod = lodName;
    return compacted;
  }

  compactionPending(source) {
    const geometry = this.staging.get(source);
    return Boolean(geometry) && geometry.userData.compactDone === false;
  }

  commitStaged(layoutRevision) {
    if (this.stagingRevision !== layoutRevision) return;
    if ([...this.staging.values()].some(geometry => geometry.userData.compactDone === false)) return;
    this.cancelCompactions();
    this.#disposeMap(this.cache);
    this.cache = this.staging;
    this.staging = new Map();
    this.valid = new Set(this.cache.keys());
    this.layoutRevision = layoutRevision;
    this.requestedRevision = layoutRevision;
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
    this.cancelCompactions();
    this.valid.clear();
    this.#disposeMap(this.cache);
    this.discardStaging();
  }

  dispose(scene) {
    this.disposed = true;
    this.invalidate();
    scene.remove(this.mesh);
  }
}
