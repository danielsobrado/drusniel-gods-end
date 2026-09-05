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
import { GrassMask } from './GrassMask.js';
import { GrassMaterial } from './GrassMaterial.js';
import { GrassPainter } from './GrassPainter.js';
import { createGrassTerrainData } from './GrassTerrainData.js';
import { GrassTile } from './GrassTile.js';
import { InteractionMap } from './InteractionMap.js';

const GRASS_TYPES = ['blade', 'billboard'];
const PAINTER_LOD = 'low';

export class GrassField {
  constructor(scene, camera, renderer, config, terrainSampler) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.config = config;
    this.terrainSampler = terrainSampler;
    this.type = config.grass.type;
    this.qualityName = config.ui.initialQuality;
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
    this.mask = new GrassMask(config, terrainSampler);
    this.containsGrass = (x, z) => this.mask.allowsVegetation(x, z);
    this.interactionMap = new InteractionMap(config, terrainSampler);
    this.geometryFactory = new GrassGeometryFactory(config);
    this.geometries = {};
    this.materialControllers = {};
    this.materialController = null;
    this.grassTerrainData = null;
    this.atlasTexture = null;
    this.painter = null;
    this.gridSizeX = 0;
    this.gridSizeZ = 0;
    this.stats = { visibleTiles: 0, submittedBlades: 0, maskedBlades: 0 };
  }

  async init() {
    this.terrainSampler.bounds.getCenter(this.terrainCenter);
    await this.mask.load();
    try {
      this.grassTerrainData = await createGrassTerrainData(
        this.renderer,
        this.terrainSampler.target,
        this.config.grass.heightResolution,
      );
    } catch (error) {
      logger.warn('Recovered GPU grass height texture failed; using CPU terrain texture.', error);
      this.grassTerrainData = this.terrainSampler;
    }

    this.atlasTexture = await loadGrassAtlas(this.config);
    for (const type of GRASS_TYPES) {
      this.materialControllers[type] = new GrassMaterial(
        this.config,
        this.grassTerrainData,
        this.mask,
        this.interactionMap,
        type,
        type === 'billboard' ? this.atlasTexture : null,
      );
    }
    this.materialController = this.materialControllers[this.type];
    this.#applyQuality(this.qualityName, true);
    return this;
  }

  attachPainter({ terrain, player }) {
    this.painter = new GrassPainter({
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      terrain,
      mask: this.mask,
      config: this.config,
      player,
      onChange: () => this.remapEmptyTiles(),
      onClose: () => this.setPainterEnabled(false),
    });
    this.setPainterEnabled(this.config.painter.enabled);
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
        detail: lod[name].detail,
        density: lod[name].density,
      }),
    ]));
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
      painterEnabled: Boolean(this.config.painter.enabled),
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
        tile.mesh.material = this.materialController.material;
        tile.setGeometry(this.geometries[PAINTER_LOD], PAINTER_LOD);
      }
    }
    this.remapEmptyTiles();
  }

  setQuality(name) {
    if (name === this.qualityName) return;
    this.#applyQuality(name);
  }

  setGrassType(type) {
    if (!GRASS_TYPES.includes(type) || type === this.type) return;
    this.type = type;
    this.materialController = this.materialControllers[type];
    this.#rebuildGeometries();
    this.materialController.setMaxDistance(this.#getQuality().maxDistance);
    this.materialController.setLod(this.#getQuality());
    if (this.config.cinematic?.enabled) {
      this.#buildTilePool();
      return;
    }
    for (const tile of this.tiles) {
      const lodName = this.painter?.enabled
        ? PAINTER_LOD
        : tile.mesh.userData.currentLOD ?? 'veryLow';
      tile.mesh.material = this.materialController.material;
      tile.setGeometry(this.geometries[lodName] ?? this.geometries.veryLow, lodName);
    }
  }

  setPreset(preset) {
    for (const type of GRASS_TYPES) {
      this.materialControllers[type]?.setPreset(preset.grass[type] ?? preset.grass.blade);
    }
  }

  setInteractionEnabled(enabled) {
    this.interactionMap.setEnabled(enabled);
  }

  setPainterEnabled(enabled) {
    if (!this.painter) return false;
    this.painter.setEnabled(Boolean(enabled));
    return this.painter.enabled;
  }

  togglePainter() {
    return this.setPainterEnabled(!(this.painter?.enabled ?? false));
  }

  remapEmptyTiles() {
    for (const tile of this.tiles) tile.invalidate();
    if (this.config.cinematic?.enabled) return;
    this.emptyGrassTiles = this.mask.createEmptyTileSet(
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
    // Toroidal reuse: crossing one cell only recycles the outgoing row/column.
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

  update(deltaSeconds, elapsedSeconds, playerPosition, influencePoints = []) {
    this.interactionMap.update(playerPosition, influencePoints);
    this.materialController.setInteractionCenter(this.interactionMap.center);
    this.painter?.update(deltaSeconds);

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
    const bladeHeight = Number(this.materialController.uniforms.bladeHeight.value);
    const painterEnabled = this.painter?.enabled ?? false;

    this.camera.updateMatrixWorld();
    this.projectionView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projectionView, this.camera.coordinateSystem);
    Object.assign(this.stats, { visibleTiles: 0, submittedBlades: 0, maskedBlades: 0 });
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

      const lodName = painterEnabled
        ? PAINTER_LOD
        : selectGrassLod(distanceSquared, maxDistance, quality.lod);
      tile.setGeometry(this.geometries[lodName], lodName, this.containsGrass);
      if (tile.mesh.geometry.instanceCount === 0) tile.setVisible(false);
      else this.stats.visibleTiles++;
      this.stats.submittedBlades += tile.mesh.geometry.instanceCount;
      this.stats.maskedBlades += this.geometries[lodName].instanceCount - tile.mesh.geometry.instanceCount;
    }
  }

  sampleMask(x, z) {
    return this.mask.sampleWorld(x, z);
  }

  dispose() {
    for (const tile of this.tiles) tile.dispose(this.scene);
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    for (const controller of Object.values(this.materialControllers)) controller.dispose();
    this.atlasTexture?.dispose?.();
    if (this.grassTerrainData !== this.terrainSampler) this.grassTerrainData?.dispose?.();
    this.interactionMap.texture.dispose();
    this.mask.dispose();
  }
}
