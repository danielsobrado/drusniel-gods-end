import * as THREE from 'three';
import { logger } from '../utils/logger.js';
import { loadGrassAtlas } from './GrassAtlas.js';
import {
  LOD_ORDER,
  computeGrassGrid,
  grassLodThresholds,
  selectGrassLodFromThresholds,
  terrainTileKey,
  tileDistanceSquared,
  tileOverlapsTerrain,
} from './GrassFieldLayout.js';
import { GrassGeometryFactory } from './GrassGeometryFactory.js';
import { GrassMaterial } from './GrassMaterial.js';
import { grassFamily, isGrassShape, resolveGrassShape } from './grassShapes.js';
import { createGrassTerrainData } from './GrassTerrainData.js';
import { GrassTile } from './GrassTile.js';
import { InteractionMap } from './InteractionMap.js';
import { ProceduralVegetationField } from './ProceduralVegetationField.js';
import { collectCooperative, VegetationJob } from '../foliage/vegetationRebuild.js';
import { isCoastalJungleRuntimeActive } from '../biome/CoastalJungleRuntime.js';
import { invalidateOverlappingGrassTiles } from '../world/CoastalJungleRegion.js';
import { FarGrassField } from './FarGrassField.js';
import {
  acquireCompactionScratch, compactGrassGeometry, disposeCompactionScratch, releaseCompactionScratch,
} from './compactGrassGeometry.js';
import { GrassBatches } from './GrassBatches.js';

const GRASS_TYPES = ['blade', 'billboard'];
// Metres outside a denser band at which a tile starts compacting it: about
// two seconds of running.
const GRASS_LOD_PREFETCH_MARGIN = 12;

export function enqueueGrassTileCompaction(jobs, {
  tile, source, lodName, revision, containsGrass, disposed = () => false, stepLimit = 256, prefetch = false,
}) {
  if (tile.disposed || disposed()) return false;
  if (tile.requestedRevision !== revision) {
    if (prefetch) return false;
    tile.cancelCompactions();
    tile.requestedRevision = revision;
  }
  // A prefetch only fills the tile's cache; commitCompacted keeps showing the
  // requested band, and the switch later finds this band already valid.
  if (prefetch) {
    if (!tile.cinematic || !containsGrass || (tile.layoutRevision === revision && tile.valid.has(source))) return false;
  } else tile.requestedSource = source;
  if (!tile.cinematic || !containsGrass) return tile.setGeometry(source, lodName, containsGrass, revision);
  if (tile.layoutRevision === revision && tile.valid.has(source)) {
    return tile.setGeometry(source, lodName, containsGrass, revision);
  }
  const pending = tile.compactionJobs.get(source);
  if (pending?.revision === revision && pending.generation === tile.generation && jobs.pending(pending.id)) return false;
  if (pending) pending.jobs.cancel(pending.id);
  const generation = tile.generation;
  const id = `compact:${tile.mesh.uuid}:${source.uuid}:${generation}:${revision}`;
  const x = tile.mesh.position.x, z = tile.mesh.position.z;
  let geometry = null;
  let committed = false;
  let started = false;
  const current = () => !tile.disposed && !disposed() && tile.generation === generation && tile.requestedRevision === revision;
  tile.compactionJobs.set(source, { jobs, id, generation, revision });
  jobs.replace(id, new VegetationJob({
    class: 'compaction',
    owner: 'grass',
    bounds: tile.bounds ?? tile.mesh.userData.occlusionBounds,
    // A band switch is for a tile already on screen: rank it as due now, as
    // tree LOD jobs are, or at walking speed it lost to them for ~0.3 s and
    // the tile filled in visibly late. Prefetches keep the distance ranking.
    visibleRange: prefetch ? 0 : Infinity,
    generate: function* compact() {
      while (current()) {
        if (!started) {
          started = true;
          geometry = acquireCompactionScratch(source);
        }
        geometry = compactGrassGeometry(source, x, z, containsGrass, geometry, { resume: true, limit: stepLimit });
        if (geometry.userData.compactDone) return;
        yield;
      }
    },
    publish: () => {
      if (current() && geometry) committed = tile.commitCompacted(source, geometry, lodName, revision);
    },
    onSettled: () => {
      if (!committed) releaseCompactionScratch(source, geometry);
      if (tile.compactionJobs.get(source)?.id === id) tile.compactionJobs.delete(source);
    },
  }));
  return false;
}

export class GrassField {
  constructor(scene, camera, renderer, config, terrainSampler, trees = [], { assets = null } = {}) {
    this.scene = scene;
    this.assets = assets;
    this.camera = camera;
    this.renderer = renderer;
    this.config = config;
    this.terrainSampler = terrainSampler;
    this.shape = resolveGrassShape(config.grass);
    this.type = grassFamily(this.shape);
    this.qualityName = config.ui.initialQuality;
    this.renderEnabled = true;
    this.shareVertices = true;
    this.tiles = [];
    this.terrainCenter = new THREE.Vector3();
    this.cameraTile = new THREE.Vector2(Number.NaN, Number.NaN);
    this.frustum = new THREE.Frustum();
    this.projectionView = new THREE.Matrix4();
    this.tempBox = new THREE.Box3();
    this.tileBox = new THREE.Box3();
    this.tileBoxMin = new THREE.Vector3();
    this.tileBoxMax = new THREE.Vector3();
    this.emptyGrassTiles = new Set();
    this.lodThresholds = [];
    this.vegetation = new ProceduralVegetationField(config, terrainSampler, trees);
    this.layoutRevision = 0;
    this.coastalJungleRuntimeActive = isCoastalJungleRuntimeActive(config);
    this.referenceState = null;
    this.containsGrass = (x, z) => this.vegetation.allowsVegetation(x, z)
      && (!this.referenceState || (!this.referenceState.solids.overlaps(x, z)
        && this.referenceState.field.retainsGrass(x, z)));
    this.interactionMap = new InteractionMap(config, terrainSampler);
    this.geometryFactory = new GrassGeometryFactory(config);
    this.geometries = {};
    this.materialControllers = {};
    this.materialController = null;
    this.grassTerrainData = null;
    this.atlasTexture = null;
    this.gridSizeX = 0;
    this.gridSizeZ = 0;
    this.stats = {
      visibleTiles: 0, submittedBlades: 0, proceduralCulledBlades: 0,
      compactionMs: 0, compactionTiles: 0,
    };
    this.jobs = null;
    this.batches = new GrassBatches(scene);
  }

  setRenderEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.renderEnabled === next) return;
    this.renderEnabled = next;
    this.farGrass?.setRenderEnabled(next);
    if (!next) {
      for (const tile of this.tiles) tile.setVisible(false);
      this.batches.hide();
      this.stats.visibleTiles = 0;
      this.stats.submittedBlades = 0;
      this.stats.triangles = 0;
      return;
    }
    this.cameraTile.set(Number.NaN, Number.NaN);
  }

  setScheduler(jobs) {
    this.jobs = jobs ?? null;
  }

  async init(signal) {
    signal?.throwIfAborted();
    this.terrainSampler.bounds.getCenter(this.terrainCenter);
    await this.vegetation.build();
    signal?.throwIfAborted();
    try {
      this.grassTerrainData = await createGrassTerrainData(
        this.renderer,
        this.terrainSampler.target,
        this.config.grass.heightResolution,
      );
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn('GPU grass height texture failed; using CPU terrain texture.', error);
      this.grassTerrainData = this.terrainSampler;
    }

    if (signal?.aborted) {
      if (this.grassTerrainData !== this.terrainSampler) this.grassTerrainData?.dispose();
      signal.throwIfAborted();
    }
    this.atlasTexture = await loadGrassAtlas(this.config);
    if (signal?.aborted) {
      this.atlasTexture?.dispose();
      signal.throwIfAborted();
    }
    for (const type of GRASS_TYPES) {
      this.materialControllers[type] = new GrassMaterial(
        this.config,
        this.grassTerrainData,
        this.vegetation,
        this.interactionMap,
        type,
        type === 'billboard' ? this.atlasTexture : null,
        false,
        { batched: true, pathSampler: this.terrainSampler },
      );
    }
    this.materialController = this.materialControllers[this.type];
    this.#applyQuality(this.qualityName, true);
    if (this.config.grass.far?.enabled) {
      this.farGrass = new FarGrassField(this);
      try { await this.farGrass.init(signal); }
      catch (error) {
        this.farGrass.dispose(); this.farGrass = null;
        for (const controller of Object.values(this.materialControllers)) {
          controller.farAvailable = false;
          controller.handoff.value = 1e9;
        }
        if (signal?.aborted) throw error;
        logger.warn('Distant grass atlas unavailable; retaining near grass.', error);
      }
    }
    return this;
  }

  #getQuality() {
    return this.config.quality[this.qualityName][this.type];
  }

  // Tiles each LOD ring can hold, with margin, so batches never grow mid-route.
  #batchSlots() {
    const quality = this.#getQuality(), size = this.config.grass.tileSize, reach = size * Math.SQRT1_2;
    let inner = 0;
    return Object.fromEntries(LOD_ORDER.map((name) => {
      const outer = quality.lod[name].distance * quality.maxDistance;
      const area = Math.PI * ((outer + reach) ** 2 - Math.max(0, inner - reach) ** 2);
      inner = outer;
      return [name, Math.ceil(area / (size * size) * 1.25)];
    }));
  }

  #rebuildGeometries() {
    for (const tile of this.tiles) tile.invalidate();
    const previous = this.geometries;
    const lod = this.#getQuality().lod;
    this.geometries = Object.fromEntries(LOD_ORDER.map((name) => [
      name,
      this.geometryFactory.create({
        type: this.type,
        shape: this.shape,
        detail: lod[name].detail,
        density: lod[name].density,
        shareVertices: this.shareVertices,
      }),
    ]));
    for (const tile of this.tiles) {
      if (!tile.mesh) continue;
      const lodName = tile.mesh.userData.currentLOD ?? 'veryLow';
      tile.setGeometry(this.geometries[lodName] ?? this.geometries.veryLow, lodName, this.containsGrass, this.layoutRevision);
    }
    this.batches.setTemplates(this.geometries, this.materialController.material, this.#batchSlots());
    for (const geometry of Object.values(previous)) {
      disposeCompactionScratch(geometry);
      geometry.dispose();
    }
  }

  #buildTilePool() {
    for (const tile of this.tiles) tile.dispose(this.scene);
    this.tiles.length = 0;

    const grid = computeGrassGrid({
      terrainSizeX: this.terrainSampler.size.x,
      terrainSizeZ: this.terrainSampler.size.z,
      tileSize: this.config.grass.tileSize,
      maxDistance: this.#getQuality().maxDistance + this.config.grass.tileSize,
    });
    this.gridSizeX = grid.gridSizeX;
    this.gridSizeZ = grid.gridSizeZ;

    for (let index = 0; index < this.gridSizeX * this.gridSizeZ; index += 1) {
      this.tiles.push(new GrassTile(
        this.scene,
        this.materialController.material,
        this.geometries.veryLow,
        Boolean(this.config.cinematic?.enabled),
        false,
      ));
    }

    const tileSize = this.config.grass.tileSize;
    const centerTileX = Math.floor((this.camera.position.x - this.terrainCenter.x) / tileSize);
    const centerTileZ = Math.floor((this.camera.position.z - this.terrainCenter.z) / tileSize);
    this.cameraTile.set(centerTileX, centerTileZ);
    this.#repositionTiles(centerTileX, centerTileZ);
  }

  #applyQuality(name, initialize = false) {
    if (!this.config.quality[name]) throw new Error(`Unknown quality profile: ${name}`);
    this.qualityName = name;
    this.#rebuildGeometries();
    this.materialController.setMaxDistance(this.#getQuality().maxDistance);
    this.materialController.setLod(this.#getQuality());

    if (initialize || this.tiles.length === 0 || this.config.cinematic?.enabled) {
      this.#buildTilePool();
    } else {
      for (const tile of this.tiles) {
        const lodName = tile.mesh.userData.currentLOD ?? 'veryLow';
        tile.mesh.material = this.materialController.material;
        tile.setGeometry(this.geometries[lodName] ?? this.geometries.veryLow, lodName, this.containsGrass, this.layoutRevision);
      }
    }
    this.remapEmptyTiles();
  }

  setQuality(name) {
    if (name === this.qualityName) return;
    this.#applyQuality(name);
  }

  setShareVertices(shareVertices) {
    const next = shareVertices !== false;
    if (next === this.shareVertices) return;
    this.shareVertices = next;
    this.#rebuildGeometries();
    this.remapEmptyTiles();
  }

  setGrassShape(shape) {
    if (!isGrassShape(shape) || shape === this.shape) return;
    const previousType = this.type;
    this.shape = shape;
    this.type = grassFamily(shape);
    this.materialController = this.materialControllers[this.type];
    this.#rebuildGeometries();
    this.materialController.setMaxDistance(this.#getQuality().maxDistance);
    this.materialController.setLod(this.#getQuality());
    if (this.config.cinematic?.enabled && previousType !== this.type) {
      this.#buildTilePool();
      this.remapEmptyTiles();
      return;
    }
    for (const tile of this.tiles) {
      const lodName = tile.mesh.userData.currentLOD ?? 'veryLow';
      tile.mesh.material = this.materialController.material;
      tile.setGeometry(this.geometries[lodName] ?? this.geometries.veryLow, lodName, this.containsGrass, this.layoutRevision);
    }
    this.remapEmptyTiles();
  }

  prepareReferenceMaterials() {
    if (this.referenceControllers) return;
    this.originalControllers = this.materialControllers;
    this.referenceControllers = {};
    for (const type of GRASS_TYPES) {
      this.referenceControllers[type] = new GrassMaterial(this.config, this.grassTerrainData,
        this.vegetation, this.interactionMap, type, type === 'billboard' ? this.atlasTexture : null, true,
        { batched: true });
    }
  }

  setReferenceBiome(state) {
    if (state === this.referenceState) return;
    if (state) this.prepareReferenceMaterials();
    this.referenceState = state;
    this.layoutRevision += 1;
    this.materialControllers = state ? this.referenceControllers : this.originalControllers ?? this.materialControllers;
    this.materialController = this.materialControllers[this.type];
    this.materialController.setMaxDistance(this.#getQuality().maxDistance);
    this.materialController.setLod(this.#getQuality());
    for (const tile of this.tiles) {
      tile.invalidate();
      tile.mesh.material = this.materialController.material;
    }
  }

  containsPredicate(state) {
    return (x, z) => this.vegetation.allowsVegetation(x, z)
      && (!state || (!state.solids.overlaps(x, z) && state.field.retainsGrass(x, z)));
  }

  async prepareLayout(state, { signal } = {}) {
    if (state) this.prepareReferenceMaterials();
    const revision = this.layoutRevision + 1;
    const containsGrass = this.containsPredicate(state);
    await collectCooperative((function* stageTiles() {
      for (const tile of this.tiles) {
        const lodName = tile.mesh.userData.currentLOD ?? 'veryLow';
        const source = this.geometries[lodName];
        if (source) tile.stageGeometry(source, lodName, containsGrass, revision);
        yield;
      }
    }).call(this), { signal });
    this.pendingLayout = { state, revision };
    return this.pendingLayout;
  }

  commitLayout(prepared = this.pendingLayout) {
    if (!prepared) {
      this.setReferenceBiome(null);
      return;
    }
    const { state, revision } = prepared;
    if (state) this.prepareReferenceMaterials();
    this.referenceState = state;
    this.layoutRevision = revision;
    this.containsGrass = this.containsPredicate(state);
    this.materialControllers = state ? this.referenceControllers : this.originalControllers ?? this.materialControllers;
    this.materialController = this.materialControllers[this.type];
    this.materialController.setMaxDistance(this.#getQuality().maxDistance);
    this.materialController.setLod(this.#getQuality());
    for (const tile of this.tiles) {
      tile.commitStaged(revision);
      tile.mesh.material = this.materialController.material;
    }
    this.pendingLayout = null;
  }

  abortLayout() {
    for (const tile of this.tiles) tile.discardStaging();
    this.pendingLayout = null;
  }

  setPreset(preset) {
    for (const type of GRASS_TYPES) {
      this.materialControllers[type]?.setPreset(preset.grass[type] ?? preset.grass.blade);
    }
  }

  setInteractionEnabled(enabled) {
    this.interactionMap.setEnabled(enabled);
  }

  remapEmptyTiles() {
    if (this.farGrass) {
      this.farGrass.revision = -1;
      for (const tile of this.farGrass.tiles ?? []) tile.invalidate();
    }
    for (const tile of this.tiles) tile.invalidate();
    this.emptyGrassTiles = this.vegetation.createEmptyTileSet(
      this.terrainSampler.size.x,
      this.terrainSampler.size.z,
      this.config.grass.tileSize,
    );
    for (const tile of this.tiles) this.#refreshTileEmpty(tile);
  }

  // Cached per tile because it only depends on the tile position and the
  // empty-tile set; evaluating it per frame built a string key per tile.
  #refreshTileEmpty(tile) {
    const { x, z } = tile.mesh.position;
    const tileSize = this.config.grass.tileSize;
    const bounds = this.terrainSampler.bounds;
    tile.isEmpty = !tileOverlapsTerrain(x, z, tileSize, bounds)
      || this.emptyGrassTiles.has(terrainTileKey(x, z, tileSize, bounds));
  }

  #repositionTiles(centerTileX, centerTileZ) {
    const halfX = Math.floor(this.gridSizeX / 2);
    const halfZ = Math.floor(this.gridSizeZ / 2);
    const tileSize = this.config.grass.tileSize;
    const halfTile = tileSize * 0.5;
    const wrap = (value, size) => ((value % size) + size) % size;

    for (let gridZ = 0; gridZ < this.gridSizeZ; gridZ += 1) {
      for (let gridX = 0; gridX < this.gridSizeX; gridX += 1) {
        const tileX = centerTileX + gridX - halfX;
        const tileZ = centerTileZ + gridZ - halfZ;
        const x = this.terrainCenter.x + tileX * tileSize;
        const z = this.terrainCenter.z + tileZ * tileSize;
        const tile = this.tiles[wrap(tileZ, this.gridSizeZ) * this.gridSizeX + wrap(tileX, this.gridSizeX)];
        if (tile.mesh.position.x === x && tile.mesh.position.z === z && tile.minHeight !== undefined) continue;
        tile.setPosition(x, z, tileX, tileZ);

        this.tileBox.set(
          this.tileBoxMin.set(x - halfTile, 0, z - halfTile),
          this.tileBoxMax.set(x + halfTile, 0, z + halfTile),
        );
        const range = this.terrainSampler.getHeightRange(this.tileBox);
        tile.minHeight = range.min;
        tile.maxHeight = range.max;
        this.#refreshTileEmpty(tile);
      }
    }
  }

  #syncCoastalJungleRuntime() {
    const active = isCoastalJungleRuntimeActive(this.config);
    if (active === this.coastalJungleRuntimeActive) return;
    this.coastalJungleRuntimeActive = active;
    const profile = this.config.biomes?.coastalJungle;
    const sea = this.config.water?.sea;
    const edge = profile?.ecology?.edgeFade ?? 18;
    invalidateOverlappingGrassTiles(this.tiles, this.config.grass.tileSize, profile?.region, sea, edge);
    if (this.farGrass?.tiles && this.farGrass.settings) {
      invalidateOverlappingGrassTiles(
        this.farGrass.tiles, this.farGrass.settings.chunkSize, profile?.region, sea, edge,
      );
    }
  }

  update(deltaSeconds, elapsedSeconds, playerPosition, influencePoints = []) {
    if (!this.renderEnabled) return;
    const cullingStarted = performance.now();
    this.#syncCoastalJungleRuntime();
    this.interactionMap.update(playerPosition, influencePoints);
    this.materialController.setInteractionCenter(this.interactionMap.center);

    const tileSize = this.config.grass.tileSize;
    const centerTileX = Math.floor((this.camera.position.x - this.terrainCenter.x) / tileSize);
    const centerTileZ = Math.floor((this.camera.position.z - this.terrainCenter.z) / tileSize);
    if (centerTileX !== this.cameraTile.x || centerTileZ !== this.cameraTile.y) {
      this.cameraTile.set(centerTileX, centerTileZ);
      this.#repositionTiles(centerTileX, centerTileZ);
    }

    const quality = this.#getQuality();
    const maxDistance = quality.maxDistance;
    const maxDistanceSquared = maxDistance * maxDistance;
    const bladeHeight = Number(this.materialController.uniforms.bladeHeight.value) * (this.referenceState ? 2.6 : 1);

    this.camera.updateMatrixWorld();
    this.projectionView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projectionView, this.camera.coordinateSystem);
    const stats = this.stats;
    stats.visibleTiles = 0;
    stats.submittedBlades = 0;
    stats.proceduralCulledBlades = 0;
    stats.compactionMs = 0;
    stats.compactionTiles = 0;
    stats.shareVertices = this.shareVertices;
    stats.lods = { high: 0, medium: 0, low: 0, veryLow: 0 };
    stats.lodInstances = { high: 0, medium: 0, low: 0, veryLow: 0 };
    stats.triangles = 0;
    this.materialController.setFrame(elapsedSeconds, this.camera.position);
    this.materialController.setViewProjection(this.projectionView);

    const boundingBox = this.geometries.high.boundingBox;
    const lodThresholds = grassLodThresholds(maxDistance, quality.lod, this.lodThresholds);
    const cameraX = this.camera.position.x;
    const cameraZ = this.camera.position.z;
    const tempBox = this.tempBox;
    this.batches.begin();

    for (const tile of this.tiles) {
      if (tile.isEmpty) {
        tile.setVisible(false);
        continue;
      }

      const { x, z } = tile.mesh.position;
      const distanceSquared = tileDistanceSquared(cameraX, cameraZ, x, z, tileSize);
      if (distanceSquared >= maxDistanceSquared) {
        tile.setVisible(false);
        continue;
      }

      if (!boundingBox) continue;
      // The tile mesh is a pure translation of the shared template, so offsetting
      // the template bounds equals Box3.applyMatrix4 with the tile matrix.
      tempBox.min.set(boundingBox.min.x + x, tile.minHeight - bladeHeight, boundingBox.min.z + z);
      tempBox.max.set(boundingBox.max.x + x, tile.maxHeight + bladeHeight, boundingBox.max.z + z);
      tempBox.expandByScalar(bladeHeight);
      tile.mesh.userData.occlusionBounds.copy(tempBox);
      const inView = this.frustum.intersectsBox(tempBox);
      tile.setVisible(inView);
      if (!inView && !this.jobs) continue;

      const lodName = selectGrassLodFromThresholds(distanceSquared, lodThresholds);
      const source = this.geometries[lodName];
      const compacted = this.compactTile(tile, source, lodName);
      this.#prefetchDenserLod(tile, lodName, distanceSquared, lodThresholds);
      if (this.jobs && !tile.hasValidGeometry(this.layoutRevision)) {
        tile.setVisible(false);
        continue;
      }
      // Every in-range tile joins its LOD's batch, in view or not, so turning
      // the camera never rebuilds a batch (GrassBatches).
      if (tile.mesh.geometry.instanceCount > 0) this.batches.add(tile.mesh.userData.currentLOD, tile);
      if (!inView) continue;
      if (compacted) {
        this.stats.compactionMs += tile.lastCompactionMs;
        this.stats.compactionTiles += 1;
      }
      if (tile.mesh.geometry.instanceCount === 0) tile.setVisible(false);
      else { this.stats.visibleTiles++; stats.lods[tile.mesh.userData.currentLOD]++; }
      stats.lodInstances[tile.mesh.userData.currentLOD] += tile.mesh.geometry.instanceCount;
      stats.triangles += (tile.mesh.geometry.index?.count ?? tile.mesh.geometry.attributes.position.count) / 3 * tile.mesh.geometry.instanceCount;
      this.stats.submittedBlades += tile.mesh.geometry.instanceCount;
      this.stats.proceduralCulledBlades += this.geometries[tile.mesh.userData.currentLOD].instanceCount - tile.mesh.geometry.instanceCount;
    }
    this.batches.commit(this.materialController.material);
    this.farGrass?.update(elapsedSeconds);
    stats.far = this.farGrass?.stats ?? null;
    stats.triangles += stats.far?.triangles ?? 0;
    stats.cullingMs = performance.now() - cullingStarted;
  }

  // A tile switches to a denser band only once that band is compacted, so a
  // tile being walked towards used to stay sparse for several metres inside
  // the denser band and then fill in at once. Compacting the next band while
  // the tile is still this far outside it makes the switch immediate.
  #prefetchDenserLod(tile, lodName, distanceSquared, thresholds) {
    if (!this.jobs) return;
    const index = thresholds.indexOf(lodName);
    if (index < 2) return;
    const boundary = Math.sqrt(thresholds[index - 1]) + GRASS_LOD_PREFETCH_MARGIN;
    if (distanceSquared >= boundary * boundary) return;
    const denser = thresholds[index - 2];
    enqueueGrassTileCompaction(this.jobs, {
      tile, source: this.geometries[denser], lodName: denser, revision: this.layoutRevision,
      containsGrass: this.containsGrass, disposed: () => this.disposed, stepLimit: 256, prefetch: true,
    });
  }

  compactTile(tile, source, lodName) {
    if (!this.jobs) {
      return tile.setGeometry(source, lodName, this.containsGrass, this.layoutRevision);
    }
    return enqueueGrassTileCompaction(this.jobs, {
      tile, source, lodName, revision: this.layoutRevision, containsGrass: this.containsGrass,
      disposed: () => this.disposed, stepLimit: 256,
    });
  }

  sampleVegetation(x, z) {
    const ecology = this.vegetation.sampleWorld(x, z);
    if (!this.referenceState) return ecology;
    if (this.referenceState.solids.overlaps(x, z)) return { ...ecology, density: 0, growth: 0, understory: 0, path: 1 };
    const mass = this.referenceState.field.sampleWorld(x, z).mass;
    return { ...ecology, density: ecology.density * (0.6 + 0.4 * mass),
      understory: ecology.understory * (0.6 + 0.4 * mass) };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.farGrass?.dispose();
    for (const tile of this.tiles) tile.dispose(this.scene);
    this.batches.dispose();
    for (const geometry of Object.values(this.geometries)) {
      disposeCompactionScratch(geometry);
      geometry.dispose();
    }
    for (const controller of new Set([...Object.values(this.materialControllers),
      ...Object.values(this.originalControllers ?? {}), ...Object.values(this.referenceControllers ?? {})])) controller.dispose();
    this.atlasTexture?.dispose?.();
    if (this.grassTerrainData !== this.terrainSampler) this.grassTerrainData?.dispose?.();
    this.interactionMap.texture.dispose();
    this.vegetation.dispose();
  }
}
