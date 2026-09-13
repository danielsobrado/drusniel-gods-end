import * as THREE from 'three';
import { logger } from '../utils/logger.js';
import { loadGrassAtlas } from './GrassAtlas.js';
import {
  LOD_ORDER,
  computeGrassGrid,
  selectGrassLod,
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
import { collectCooperative } from '../foliage/vegetationRebuild.js';
import { isCoastalJungleRuntimeActive } from '../biome/CoastalJungleRuntime.js';

const GRASS_TYPES = ['blade', 'billboard'];

export class GrassField {
  constructor(scene, camera, renderer, config, terrainSampler, trees = []) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.config = config;
    this.terrainSampler = terrainSampler;
    this.shape = resolveGrassShape(config.grass);
    this.type = grassFamily(this.shape);
    this.qualityName = config.ui.initialQuality;
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
      logger.warn('Recovered GPU grass height texture failed; using CPU terrain texture.', error);
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
      );
    }
    this.materialController = this.materialControllers[this.type];
    this.#applyQuality(this.qualityName, true);
    return this;
  }

  #getQuality() {
    return this.config.quality[this.qualityName][this.type];
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
    for (const geometry of Object.values(previous)) geometry.dispose();
  }

  #buildTilePool() {
    for (const tile of this.tiles) tile.dispose(this.scene);
    this.tiles.length = 0;

    const grid = computeGrassGrid({
      terrainSizeX: this.terrainSampler.size.x,
      terrainSizeZ: this.terrainSampler.size.z,
      tileSize: this.config.grass.tileSize,
      maxDistance: this.#getQuality().maxDistance + this.config.grass.tileSize,
      painterEnabled: false,
    });
    this.gridSizeX = grid.gridSizeX;
    this.gridSizeZ = grid.gridSizeZ;

    for (let index = 0; index < this.gridSizeX * this.gridSizeZ; index += 1) {
      this.tiles.push(new GrassTile(
        this.scene,
        this.materialController.material,
        this.geometries.veryLow,
        Boolean(this.config.cinematic?.enabled),
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
        this.vegetation, this.interactionMap, type, type === 'billboard' ? this.atlasTexture : null, true);
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
    for (const tile of this.tiles) tile.invalidate();
    this.emptyGrassTiles = this.vegetation.createEmptyTileSet(
      this.terrainSampler.size.x,
      this.terrainSampler.size.z,
      this.config.grass.tileSize,
    );
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
      }
    }
  }

  #syncCoastalJungleRuntime() {
    const active = isCoastalJungleRuntimeActive(this.config);
    if (active === this.coastalJungleRuntimeActive) return;
    this.coastalJungleRuntimeActive = active;
    this.layoutRevision += 1;
    for (const tile of this.tiles) tile.invalidate();
  }

  update(deltaSeconds, elapsedSeconds, playerPosition, influencePoints = []) {
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
    const bounds = this.terrainSampler.bounds;
    const bladeHeight = Number(this.materialController.uniforms.bladeHeight.value) * (this.referenceState ? 2.6 : 1);

    this.camera.updateMatrixWorld();
    this.projectionView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projectionView, this.camera.coordinateSystem);
    Object.assign(this.stats, {
      visibleTiles: 0, submittedBlades: 0, proceduralCulledBlades: 0,
      compactionMs: 0, compactionTiles: 0,
      shareVertices: this.shareVertices,
    });
    this.materialController.setFrame(elapsedSeconds, this.camera.position);
    this.materialController.setViewProjection(this.projectionView);

    for (const tile of this.tiles) {
      const { x, z } = tile.mesh.position;
      if (!tileOverlapsTerrain(x, z, tileSize, bounds)) {
        tile.setVisible(false);
        continue;
      }

      if (this.emptyGrassTiles.has(terrainTileKey(x, z, tileSize, bounds))) {
        tile.setVisible(false);
        continue;
      }

      const distanceSquared = tileDistanceSquared(
        this.camera.position.x,
        this.camera.position.z,
        x,
        z,
        tileSize,
      );
      if (distanceSquared >= maxDistanceSquared) {
        tile.setVisible(false);
        continue;
      }

      tile.mesh.updateMatrixWorld();
      const boundingBox = this.geometries.high.boundingBox;
      if (!boundingBox) continue;
      this.tempBox.copy(boundingBox).applyMatrix4(tile.mesh.matrixWorld);
      this.tempBox.min.y = tile.minHeight - bladeHeight;
      this.tempBox.max.y = tile.maxHeight + bladeHeight;
      this.tempBox.expandByScalar(bladeHeight);
      tile.mesh.userData.occlusionBounds.copy(this.tempBox);
      tile.setVisible(this.frustum.intersectsBox(this.tempBox));
      if (!tile.mesh.visible) continue;

      const lodName = selectGrassLod(distanceSquared, maxDistance, quality.lod);
      const compacted = tile.setGeometry(this.geometries[lodName], lodName, this.containsGrass, this.layoutRevision);
      if (compacted) {
        this.stats.compactionMs += tile.lastCompactionMs;
        this.stats.compactionTiles += 1;
      }
      if (tile.mesh.geometry.instanceCount === 0) tile.setVisible(false);
      else this.stats.visibleTiles++;
      this.stats.submittedBlades += tile.mesh.geometry.instanceCount;
      this.stats.proceduralCulledBlades += this.geometries[lodName].instanceCount - tile.mesh.geometry.instanceCount;
    }
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
    for (const tile of this.tiles) tile.dispose(this.scene);
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    for (const controller of new Set([...Object.values(this.materialControllers),
      ...Object.values(this.originalControllers ?? {}), ...Object.values(this.referenceControllers ?? {})])) controller.dispose();
    this.atlasTexture?.dispose?.();
    if (this.grassTerrainData !== this.terrainSampler) this.grassTerrainData?.dispose?.();
    this.interactionMap.texture.dispose();
    this.vegetation.dispose();
  }
}
