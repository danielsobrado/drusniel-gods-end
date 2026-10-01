import * as THREE from 'three/webgpu';
import { loadVegetationLodAssets } from '../foliage/VegetationLodAssets.js';
import { createGrassGeometry } from './GrassGeometry.js';
import { GrassMaterial } from './GrassMaterial.js';
import { GrassTile } from './GrassTile.js';
import { computeGrassGrid, tileDistanceSquared, tileOverlapsTerrain } from './GrassFieldLayout.js';
import { DRAW_ORDER } from '../rendering/drawOrder.js';

/** A card represents ~180 stems. Density controls clumps, never single far-away blades. */
export class FarGrassField {
  constructor(field) { this.field = field; this.config = field.config; this.tiles = []; this.atlases = {}; this.controllers = new Map(); this.revision = -1; this.renderEnabled = true; }
  async init(signal) {
    const shapes = ['slender', 'reed', 'broadleaf'];
    this.atlasAssets = await loadVegetationLodAssets(
      shapes.map((shape) => `grass-${shape}`),
      this.config,
      signal,
      { renderer: this.field.renderer, assets: this.field.assets },
    );
    if (signal?.aborted || this.disposed) {
      this.atlasAssets.dispose();
      this.atlasAssets = null;
      signal?.throwIfAborted();
      return this;
    }
    for (const shape of shapes) {
      const atlas = this.atlasAssets.variants.get(`grass-${shape}`)?.atlas;
      if (!atlas) throw new Error(`Distant grass atlas unavailable: ${shape}`);
      this.atlases[shape] = atlas;
    }
    if (this.disposed) return this;
    this.settings = this.config.grass.far;
    this.geometry = createGrassGeometry({ type: 'billboard', shape: 'tufted', detail: 1,
      density: this.settings.density, tileSize: this.settings.chunkSize, bladeHeight: 3, stable: true });
    // Far clumps need area coverage, not the prefix ordering used by near blade LODs.
    // Stratified, deterministic jitter avoids the diagonal rows of the shared prefix sequence.
    const positions = this.geometry.attributes.instancePosition;
    const side = Math.floor(this.settings.chunkSize * this.settings.density);
    const random = (i, seed) => { const v = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453; return v - Math.floor(v); };
    for (let i = 0; i < positions.count; i++) positions.setXYZ(i,
      ((i % side + random(i, 1)) / side - 0.5) * this.settings.chunkSize, 0,
      ((Math.floor(i / side) + random(i, 2)) / side - 0.5) * this.settings.chunkSize);
    this.stats = { billboards: 0, triangles: 0, chunks: 0, compactionMs: 0 };
    this.rebuild();
    return this;
  }
  controller() {
    const field = this.field, shape = field.shape === 'tufted' ? 'slender' : field.shape;
    const key = `${shape}:${Boolean(field.referenceState)}`;
    if (!this.controllers.has(key)) {
      this.controllers.set(key, new GrassMaterial(this.config, field.grassTerrainData, field.vegetation,
        field.interactionMap, 'billboard', this.atlases[shape], Boolean(field.referenceState), { far: true }));
    }
    return this.controllers.get(key);
  }
  rebuild() {
    const field = this.field;
    for (const tile of this.tiles) tile.dispose(field.scene); this.tiles.length = 0;
    this.quality = field.qualityName;
    this.distance = this.settings.distances[this.quality];
    const grid = computeGrassGrid({ terrainSizeX: field.terrainSampler.size.x, terrainSizeZ: field.terrainSampler.size.z,
      tileSize: this.settings.chunkSize, maxDistance: this.distance + this.settings.chunkSize });
    this.grid = grid;
    const material = this.controller().material;
    for (let i = 0; i < grid.gridSizeX * grid.gridSizeZ; i++) {
      const tile = new GrassTile(field.scene, material, this.geometry, true); tile.mesh.name = 'Far grass clumps'; tile.mesh.renderOrder = DRAW_ORDER.farGrass;
      // The opening-view draw prepares this shared material with real compacted
      // data. A forced zero-index warmup draw invalidates its WebGL VAO binding.
      tile.mesh.userData.skipWarmup = true;
      tile.mesh.receiveShadow = false; tile.mesh.userData.occlusionCull = false;
      this.tiles.push(tile);
    }
    this.centerX = this.centerZ = NaN;
  }
  setRenderEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.renderEnabled === next) return;
    this.renderEnabled = next;
    if (!next) {
      for (const tile of this.tiles) tile.setVisible(false);
      return;
    }
    this.centerX = this.centerZ = NaN;
  }
  update(elapsedSeconds) {
    if (this.disposed || !this.renderEnabled) return;
    const field = this.field;
    if (this.quality !== field.qualityName) this.rebuild();
    const controller = this.controller(), source = field.materialController;
    const nearDistance = this.config.quality[field.qualityName][field.type].maxDistance;
    controller.handoff.value = nearDistance; controller.setMaxDistance(this.distance);
    for (const key of ['bladeHeight', 'bladeStiffness', 'baseBend', 'windDirection', 'windNoiseScale', 'simulationSpeed', 'sheen']) controller.uniforms[key].value = source.uniforms[key].value;
    controller.uniforms.bladeWidth.value = this.settings.width;
    controller.uniforms.bladeHeight.value *= this.settings.height;
    controller.uniforms.baseColor.value.copy(source.uniforms.baseColor.value); controller.uniforms.tipColor.value.copy(source.uniforms.tipColor.value);
    if (controller.cinematic && source.cinematic) for (const key of Object.keys(controller.cinematic)) controller.cinematic[key].value = source.cinematic[key].value;
    controller.setFrame(elapsedSeconds, field.camera.position); controller.setViewProjection(field.projectionView);
    const size = this.settings.chunkSize, camera = field.camera.position;
    const cx = Math.floor((camera.x - field.terrainCenter.x) / size), cz = Math.floor((camera.z - field.terrainCenter.z) / size);
    const changed = cx !== this.centerX || cz !== this.centerZ;
    const { gridSizeX: nx, gridSizeZ: nz } = this.grid;
    const wrap = (v, n) => ((v % n) + n) % n;
    if (changed) {
      this.centerX = cx; this.centerZ = cz;
      for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
        const tx = cx + ix - Math.floor(nx / 2), tz = cz + iz - Math.floor(nz / 2);
        const tile = this.tiles[wrap(tz, nz) * nx + wrap(tx, nx)];
        const x = field.terrainCenter.x + tx * size, z = field.terrainCenter.z + tz * size;
        if (tile.mesh.position.x === x && tile.mesh.position.z === z && tile.bounds) continue;
        tile.setPosition(x, z, tx, tz);
        tile.bounds = new THREE.Box3(new THREE.Vector3(x - size / 2, 0, z - size / 2), new THREE.Vector3(x + size / 2, 0, z + size / 2));
        const range = field.terrainSampler.getHeightRange(tile.bounds);
        tile.bounds.min.y = range.min - 4; tile.bounds.max.y = range.max + 8;
        tile.bounds.expandByScalar(this.settings.width);
        tile.isEmpty = !tileOverlapsTerrain(x, z, size, field.terrainSampler.bounds);
      }
    }
    const invalid = this.reference !== field.referenceState;
    this.reference = field.referenceState;
    const stats = this.stats; stats.billboards = stats.triangles = stats.chunks = stats.compactionMs = 0;
    for (const tile of this.tiles) {
      if (invalid) tile.invalidate();
      tile.mesh.material = controller.material;
      const { x, z } = tile.mesh.position;
      const nearest = tileDistanceSquared(camera.x, camera.z, x, z, size);
      const farthest = (Math.abs(camera.x - x) + size / 2) ** 2 + (Math.abs(camera.z - z) + size / 2) ** 2;
      const inRange = !tile.isEmpty && nearest < this.distance ** 2 && farthest > (nearDistance * this.settings.transitionStart) ** 2;
      tile.setVisible(inRange && field.frustum.intersectsBox(tile.bounds));
      if (!inRange || (!tile.mesh.visible && !field.jobs)) continue;
      const compacted = field.compactTile(tile, this.geometry, 'billboard');
      if (!tile.mesh.visible) continue;
      if (compacted) stats.compactionMs += tile.lastCompactionMs;
      if (field.jobs && !tile.hasValidGeometry(field.layoutRevision)) {
        tile.setVisible(false);
        continue;
      }
      const count = tile.mesh.geometry.instanceCount;
      tile.setVisible(count > 0); stats.billboards += count; stats.chunks += count > 0 ? 1 : 0;
    }
    stats.triangles = stats.billboards * 2;
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    for (const tile of this.tiles) tile.dispose(this.field.scene);
    for (const controller of this.controllers.values()) controller.dispose();
    this.atlasAssets?.dispose();
    this.atlasAssets = null;
    this.geometry?.dispose(); this.tiles.length = 0; this.controllers.clear();
  }
}
