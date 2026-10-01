import { capPopulation } from './populationCap.js';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { uniform } from 'three/tsl';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';
import { captureObjectResources } from '../utils/ResourceScope.js';
import { createWildGrassMaterial } from './wildGrassMaterial.js';
import { VegetationJob, VegetationSampleCache } from './vegetationRebuild.js';
import { iterateUnderstoryPlants, resolveUnderstorySettings } from './understoryPlacement.js';
import { bakeUnderstoryBillboard, createUnderstoryBillboard, understoryCoverage } from './understoryBillboard.js';
import { UnderstoryLod } from './understoryLod.js';
import { loadVegetationLodAssets } from './VegetationLodAssets.js';
import {
  InstanceViewCuller, IncrementalViewCull, InstanceSelectionMemo, InstanceSphereCache,
  copySelectedInstances, markAttributeUpdate,
} from './InstanceViewCuller.js';
import { DRAW_ORDER } from '../rendering/drawOrder.js';
import { adoptInstanceMatrices } from '../rendering/instanceMatrices.js';

const PLANT_ROOT_PATTERN = /^Plants_\d+$/i;
const UNDERSTORY_ATLAS_PREFIX = 'understory-';
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function meshMaterial(source) {
  return Array.isArray(source?.material) ? source.material[0] : source?.material;
}

function prepareAtlas(texture) {
  if (!texture) return;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
}

function collectPlantRoots(scene) {
  const roots = [];
  const rootNode = scene.getObjectByName('RootNode') ?? scene;
  for (const child of rootNode.children) {
    if (!PLANT_ROOT_PATTERN.test(child.name)) continue;
    let meshes = 0;
    child.traverse((object) => {
      if (object.isMesh && object.geometry) meshes += 1;
    });
    if (meshes > 0) roots.push(child);
  }
  roots.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return roots;
}

function bakePlant(root, worldScale = 1) {
  root.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3();
  const meshes = [];
  if (root.isMesh) meshes.push(root);
  root.traverse((object) => {
    if (object.isMesh && object !== root) meshes.push(object);
  });
  for (const mesh of meshes) bounds.expandByObject(mesh);
  if (bounds.isEmpty()) return null;
  const shiftX = -(bounds.min.x + bounds.max.x) * 0.5;
  const shiftY = -bounds.min.y;
  const shiftZ = -(bounds.min.z + bounds.max.z) * 0.5;
  const primitives = meshes.map((mesh) => {
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    geometry.translate(shiftX, shiftY, shiftZ);
    if (worldScale !== 1) geometry.scale(worldScale, worldScale, worldScale);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return {
      geometry,
      sourceMaterial: meshMaterial(mesh),
      height: geometry.boundingBox.max.y,
    };
  });
  return {
    name: root.name,
    primitives,
    height: Math.max(...primitives.map((primitive) => primitive.height), 0.01),
  };
}

export class UnderstorySystem {
  constructor({ scene, renderer, camera, config, terrain, grass, jobs = null, viewCullBudget = null, assets = null }) {
    this.scene = scene;
    this.assets = assets;
    this.renderer = renderer;
    this.camera = camera;
    this.config = config;
    this.viewCuller = new InstanceViewCuller(camera, config.vegetation?.viewCulling);
    this.viewCull = new IncrementalViewCull(viewCullBudget);
    this.lodCullMs = 0;
    this.terrain = terrain;
    this.grass = grass;
    this.jobs = jobs;
    this.jobId = 'understory';
    this.populateGeneration = 0;
    this.sampleCache = new VegetationSampleCache();
    this.presetName = config.ui?.initialPreset;
    this.qualityName = config.ui?.initialQuality;
    this.variants = [];
    this.meshes = [];
    this.materials = [];
    this.geometries = new Set();
    this.disposed = false;
    this.releaseGltf = null;
    this.lastCell = '';
    this.dummy = new THREE.Object3D();
    this.ready = false;
    this.renderEnabled = true;
    this.radius = uniform(0);
    this.fadeWidth = uniform(14);
    this.windIntensity = uniform(0.2);
    this.windBend = uniform(0.08);
    this.windFlutter = uniform(0.018);
    this.lodStart = uniform(22);
    this.lodEnd = uniform(30);
    this.lodPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.cameraPosition = new THREE.Vector3();
    this.lodElapsed = 0;
    this.stats = {
      plants: 0,
      visiblePlants: 0,
      culledPlants: 0,
      near: 0,
      billboards: 0,
      triangles: 0,
      fullMeshTriangles: 0,
      cullingMs: 0,
    };
  }

  async init(signal) {
    const path = this.config.assets?.foliage?.understory;
    if (!path) {
      logger.warn('Understory GLB path is not configured; skipping imported plants.');
      return this;
    }

    try {
      const gltf = await new GLTFLoader().loadAsync(assetUrl(path));
      if (signal?.aborted || this.disposed) {
        captureObjectResources(gltf.scene)();
        signal?.throwIfAborted();
        return this;
      }
      this.releaseGltf = captureObjectResources(gltf.scene);
      gltf.scene.updateMatrixWorld(true);
      const worldScale = this.#settings().worldScale ?? 1;
      const plants = collectPlantRoots(gltf.scene)
        .map((root) => bakePlant(root, worldScale))
        .filter(Boolean);
      for (const plant of plants) for (const primitive of plant.primitives) this.geometries.add(primitive.geometry);
      if (plants.length === 0) {
        logger.warn('Understory GLB contained no usable plant meshes; skipping imported plants.');
        this.releaseGltf?.();
        this.releaseGltf = null;
        return this;
      }
      await this.#createInstances(plants);
      if (this.disposed) return this;
      this.ready = true;
      this.#applySettings();
      logger.info('Imported understory plants initialized.', {
        variants: this.variants.length,
        primitives: this.meshes.length,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) {
        this.dispose();
        throw error;
      }
      logger.warn('Understory GLB failed to load; continuing without imported plants.', error);
      this.dispose();
    }
    return this;
  }

  setRenderEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.renderEnabled === next) return;
    this.renderEnabled = next;
    if (!next) {
      this.jobs?.cancel(this.jobId);
      this.viewCull.cancel();
    }
    for (const mesh of this.meshes) mesh.visible = next;
    for (const variant of this.variants) if (variant.billboard) variant.billboard.visible = next;
    if (next) {
      this.viewCuller.markDirty();
      this.lastCell = '';
      this.lodElapsed = Infinity;
      this.lodPosition.set(Infinity, Infinity, Infinity);
    }
  }

  setPreset(name) {
    this.presetName = name;
    this.#applySettings();
    this.#invalidatePopulate();
  }

  setQuality(name) {
    this.qualityName = name;
    this.#applySettings();
    this.#invalidatePopulate();
  }

  update(delta, position, environment) {
    if (!this.ready || !this.renderEnabled) return;
    const settings = this.#settings();
    const grass = environment?.grass?.blade;
    if (grass) {
      this.windIntensity.value = Number(grass.windIntensity) || 0;
    }
    if (!settings.enabled || settings.candidatesPerCell <= 0 || settings.radius <= 0) {
      this.jobs?.cancel(this.jobId);
      if (this.lastCell !== 'off') {
        this.#clearInstances();
        this.lastCell = 'off';
      }
      return;
    }

    const cellSize = settings.cellSize;
    this.lodElapsed += delta;
    this.camera?.getWorldPosition(this.cameraPosition);
    if (!this.camera) this.cameraPosition.copy(position);
    const viewChanged = this.viewCuller.update();
    const lodMoved = (this.lodElapsed >= 0.1 && !this.cameraPosition.equals(this.lodPosition))
      || this.cameraPosition.distanceToSquared(this.lodPosition) > 1;
    if (viewChanged || lodMoved) this.#requestLod();
    this.#drainLod();
    const cell = `${Math.floor(position.x / cellSize)},${Math.floor(position.z / cellSize)}`;
    if (cell === this.lastCell) return;
    this.lastCell = cell;
    this.#startPopulate(position, settings);
  }

  dispose() {
    this.disposed = true;
    this.jobs?.cancel(this.jobId);
    this.sampleCache.clear();
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    for (const variant of this.variants) {
      variant.billboard?.geometry.dispose();
      variant.billboard?.material.dispose();
      variant.billboard?.removeFromParent();
      variant.billboard?.dispose();
      variant.atlas?.target?.dispose();
    }
    this.meshes.length = 0;
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.clear();
    this.variants.length = 0;
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.billboardAssets?.dispose();
    this.billboardAssets = null;
    this.billboardAssetsAttempted = false;
    this.releaseGltf?.();
    this.releaseGltf = null;
    this.ready = false;
  }

  // Resolved settings are never mutated, so cache them per preset/quality pair
  // instead of re-merging the defaults, quality tier and preset every frame.
  #settings() {
    if (this.settingsCache && this.settingsCachePreset === this.presetName
      && this.settingsCacheQuality === this.qualityName) return this.settingsCache;
    this.settingsCache = resolveUnderstorySettings(this.config, this.presetName, this.qualityName);
    this.settingsCachePreset = this.presetName;
    this.settingsCacheQuality = this.qualityName;
    return this.settingsCache;
  }

  #applySettings() {
    const settings = this.#settings();
    this.radius.value = settings.radius;
    this.fadeWidth.value = settings.fadeWidth;
    this.windBend.value = settings.windBend;
    this.windFlutter.value = settings.windFlutter;
    this.lodStart.value = settings.billboardStart;
    this.lodEnd.value = settings.billboardEnd;
    this.lodElapsed = Infinity;
    this.lodPosition.set(Infinity, Infinity, Infinity);
    for (const mesh of this.meshes) mesh.castShadow = settings.castShadow;
  }

  #clearInstances() {
    for (const mesh of this.meshes) mesh.count = 0;
    for (const variant of this.variants) {
      variant.count = 0;
      if (variant.billboard) variant.billboard.count = 0;
      variant.detailedSelection.invalidate();
      variant.billboardSelection.invalidate();
    }
    for (const key of Object.keys(this.stats)) this.stats[key] = 0;
  }

  async #createInstances(plants) {
    const settings = this.#settings();
    const cinematic = Boolean(this.config.cinematic?.enabled);
    const capacity = Math.max(1, settings.count ?? 800);
    const shared = {
      radius: this.radius,
      fadeWidth: this.fadeWidth,
      windIntensity: this.windIntensity,
      windBend: this.windBend,
      windFlutter: this.windFlutter,
      cinematic,
      config: this.config,
    };

    for (const plant of plants) {
      const variant = {
        primitives: [],
        count: 0,
        height: plant.height,
        localBounds: new THREE.Box3(),
        visibleIndices: new Uint32Array(capacity),
        visibleCount: 0,
        cullingRevision: -1,
        cullingSourceCount: -1,
        publishedRevision: 0,
        sphereCache: new InstanceSphereCache(),
        detailedSelection: new InstanceSelectionMemo(),
        billboardSelection: new InstanceSelectionMemo(),
      };
      this.variants.push(variant);
      if (this.renderer) {
        for (const primitive of plant.primitives) prepareAtlas(primitive.sourceMaterial?.map);
        variant.pendingBillboardPlant = plant;
      }
      variant.billboardReady = uniform(variant.billboard ? 1 : 0);
      const nearCoverage = understoryCoverage(this.lodStart, this.lodEnd).near;
      const coverage = variant.billboardReady.lessThan(0.5).or(nearCoverage);
      const height = uniform(plant.height);
      for (const primitive of plant.primitives) {
        const source = primitive.sourceMaterial;
        prepareAtlas(source?.map);
        const material = createWildGrassMaterial({
          ...shared,
          map: source?.map ?? null,
          color: source?.color,
          roughness: source?.roughness ?? 0.86,
          metalness: source?.metalness ?? 0,
          height,
          alphaTest: settings.alphaTest,
          shadowAlphaTest: settings.shadowAlphaTest,
          coverage,
        });
        this.materials.push(material);
        primitive.geometry.setAttribute(
          'clumpOrigin',
          new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
        );
        const mesh = adoptInstanceMatrices(new THREE.InstancedMesh(primitive.geometry, material, capacity));
        mesh.name = `Understory ${plant.name}`;
        mesh.renderOrder = DRAW_ORDER.foliage;
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.receiveShadow = true;
        mesh.castShadow = settings.castShadow;
        mesh.userData.excludeFromReflection = true;
        mesh.userData.rainRoughness = 0.4;
        mesh.visible = this.renderEnabled;
        this.scene.add(mesh);
        this.meshes.push(mesh);
        variant.primitives.push(mesh);
        variant.localBounds.union(primitive.geometry.boundingBox);
      }
      variant.localSphere = variant.localBounds.getBoundingSphere(new THREE.Sphere());
      delete variant.localBounds;
      variant.matrices = new Float32Array(capacity * 16);
      variant.origins = new Float32Array(capacity * 3);
      variant.publishedMatrices = new Float32Array(capacity * 16);
      variant.publishedOrigins = new Float32Array(capacity * 3);
      variant.lod = new UnderstoryLod(capacity);
      variant.stagingCount = 0;
    }
  }

  async prepareBillboards(signal) {
    if (!this.renderer || this.disposed) return;
    signal?.throwIfAborted();
    await nextFrame();
    signal?.throwIfAborted();

    if (!this.billboardAssetsAttempted) {
      this.billboardAssetsAttempted = true;
      const keys = this.variants
        .map((variant) => variant.pendingBillboardPlant?.name)
        .filter(Boolean)
        .map((name) => UNDERSTORY_ATLAS_PREFIX + name);
      if (keys.length > 0) {
        try {
          this.billboardAssets = await loadVegetationLodAssets(
            keys,
            this.config,
            signal,
            { renderer: this.renderer, assets: this.assets },
          );
          signal?.throwIfAborted();
          if (this.disposed) {
            this.billboardAssets.dispose();
            this.billboardAssets = null;
            return;
          }
        } catch (error) {
          if (error?.name === 'AbortError' || signal?.aborted) throw error;
          logger.warn('Static understory billboards unavailable; falling back to runtime baking.', error);
        }
      }
    }

    const shared = {
      radius: this.radius,
      fadeWidth: this.fadeWidth,
      windIntensity: this.windIntensity,
      windBend: this.windBend,
      windFlutter: this.windFlutter,
      cinematic: Boolean(this.config.cinematic?.enabled),
      config: this.config,
    };

    for (const variant of this.variants) {
      const plant = variant.pendingBillboardPlant;
      if (!plant || variant.billboard || this.disposed) continue;
      signal?.throwIfAborted();

      const baked = this.billboardAssets?.variants.get(UNDERSTORY_ATLAS_PREFIX + plant.name);
      if (baked?.atlas && baked.entry?.capture) {
        variant.atlas = { texture: baked.atlas, ...baked.entry.capture };
        variant.pendingBillboardPlant = null;
        const capacity = Math.max(1, variant.matrices?.length / 16 || this.#settings().count || 800);
        this.#mountBillboard(variant, plant, capacity, shared);
        continue;
      }

      await nextFrame();
      signal?.throwIfAborted();
      if (this.disposed) return;
      const atlas = await bakeUnderstoryBillboard(this.renderer, plant, { nextFrame, signal });
      if (this.disposed || signal?.aborted) {
        atlas.target.dispose();
        signal?.throwIfAborted();
        return;
      }
      variant.atlas = atlas;
      variant.pendingBillboardPlant = null;
      const capacity = Math.max(1, variant.matrices?.length / 16 || this.#settings().count || 800);
      this.#mountBillboard(variant, plant, capacity, shared);
    }

    this.camera?.getWorldPosition(this.cameraPosition);
    this.viewCull.restart();
  }

  #mountBillboard(variant, plant, capacity, shared) {
    variant.billboard = createUnderstoryBillboard({ ...shared, atlas: variant.atlas, capacity,
      lodStart: this.lodStart, lodEnd: this.lodEnd });
    variant.billboard.name = `Understory billboard ${plant.name}`;
    variant.billboard.frustumCulled = false;
    variant.billboard.visible = this.renderEnabled;
    this.scene.add(variant.billboard);
    if (variant.billboardReady) variant.billboardReady.value = 1;
  }

  #invalidatePopulate() {
    this.sampleCache.clear();
    this.jobs?.cancel(this.jobId);
    this.lastCell = '';
    this.populateGeneration += 1;
  }

  #startPopulate(origin, settings) {
    const generation = ++this.populateGeneration;
    const waterY = (this.config.water?.position?.[1] ?? 0) - 0.1;
    this.pending = [];
    const generate = () => iterateUnderstoryPlants({
      origin,
      settings,
      variantCount: this.variants.length,
      sampleEcology: (x, z) => this.grass.sampleVegetation(x, z),
      contains: (x, z) => this.terrain.contains(x, z, 2),
      sampleHeight: (x, z) => this.terrain.sampleHeight(x, z),
      waterY,
      cache: this.sampleCache,
    });
    const publish = () => {
      if (generation !== this.populateGeneration) return;
      this.#publishStaging();
    };
    if (!this.jobs) {
      for (const plant of generate()) {
        if (plant) this.pending.push(plant);
      }
      Array.from(this.#finalizePopulate(origin));
      publish();
      return;
    }
    this.jobs.replace(this.jobId, new VegetationJob({
      generate,
      consume: (plant) => this.pending.push(plant),
      reset: () => { this.pending = []; },
      finalize: () => this.#finalizePopulate(origin),
      publish,
    }));
  }

  *#finalizePopulate(origin) {
    this.pending.sort((a, b) => {
      const da = (a.x - origin.x) ** 2 + (a.z - origin.z) ** 2;
      const db = (b.x - origin.x) ** 2 + (b.z - origin.z) ** 2;
      return da - db || a.x - b.x || a.z - b.z || a.variant - b.variant;
    });
    yield undefined;
    capPopulation(this.pending, this.#settings().maxInstancesTotal);
    this.#resetStaging();
    for (let i = 0; i < this.pending.length; i += 1) {
      this.#stagePlant(this.pending[i]);
      if ((i & 15) === 15) yield undefined;
    }
    this.pending.length = 0;
  }

  #resetStaging() {
    for (const variant of this.variants) variant.stagingCount = 0;
  }

  #stagePlant(plant) {
    const variant = this.variants[plant.variant];
    if (!variant?.primitives.length || !variant.matrices) return;
    const capacity = variant.matrices.length / 16;
    if (variant.stagingCount >= capacity) return;
    const index = variant.stagingCount++;
    this.dummy.position.set(plant.x, plant.y, plant.z);
    this.dummy.rotation.set(0, plant.yaw, 0);
    this.dummy.scale.set(plant.scaleX, plant.scaleY, plant.scaleZ);
    this.dummy.updateMatrix();
    this.dummy.matrix.toArray(variant.matrices, index * 16);
    variant.origins[index * 3] = plant.x;
    variant.origins[index * 3 + 1] = plant.y;
    variant.origins[index * 3 + 2] = plant.z;
  }

  #publishStaging() {
    for (const variant of this.variants) {
      const count = variant.stagingCount;
      variant.count = count;
      variant.publishedMatrices.set(variant.matrices.subarray(0, count * 16));
      variant.publishedOrigins.set(variant.origins.subarray(0, count * 3));
      variant.cullingSourceCount = -1;
      variant.publishedRevision += 1;
      variant.sphereCache.invalidate();
    }
    this.camera?.getWorldPosition(this.cameraPosition);
    this.viewCuller.update(true);
    this.viewCull.restart();
  }

  #publishDetailed(variant, indices, count) {
    if (variant.detailedSelection.matches(variant.publishedRevision, indices, count)) {
      for (const mesh of variant.primitives) mesh.count = count;
      return;
    }
    for (const mesh of variant.primitives) {
      copySelectedInstances(variant.publishedMatrices, mesh.instanceMatrix.array, 16, indices, count);
      copySelectedInstances(
        variant.publishedOrigins,
        mesh.geometry.attributes.clumpOrigin.array,
        3,
        indices,
        count,
      );
      markAttributeUpdate(mesh.instanceMatrix, count);
      markAttributeUpdate(mesh.geometry.attributes.clumpOrigin, count);
      mesh.count = count;
    }
  }

  #visibleInstances(variant) {
    const revision = this.viewCuller.revision;
    if (variant.cullingRevision === revision && variant.cullingSourceCount === variant.count) {
      return variant.visibleCount;
    }
    variant.visibleCount = this.viewCuller.collectVisible(
      variant.publishedMatrices,
      variant.count,
      variant.localSphere,
      variant.visibleIndices,
      variant.sphereCache,
    );
    variant.cullingRevision = revision;
    variant.cullingSourceCount = variant.count;
    return variant.visibleCount;
  }

  #requestLod() {
    // Refresh the movement anchor even when a pass is already pending. Otherwise
    // a camera move during a budgeted pass leaves lodPosition stale and can keep
    // scheduling repeat passes after the camera has stopped.
    this.lodElapsed = 0;
    this.lodPosition.copy(this.cameraPosition);
    this.viewCull.request();
  }

  #resetLodStats() {
    const stats = this.stats;
    for (const key of Object.keys(stats)) stats[key] = 0;
    this.lodCullMs = 0;
  }

  #drainLod() {
    if (!this.viewCull.pending) return;
    const started = performance.now();
    const complete = this.viewCull.step(
      this.variants,
      (variant) => this.#applyVariantLod(variant),
      () => this.#resetLodStats(),
    );
    this.lodCullMs += performance.now() - started;
    if (complete) this.stats.cullingMs = this.lodCullMs;
  }

  #applyVariantLod(variant) {
    const stats = this.stats;
    stats.plants += variant.count;
    const visibleCount = this.#visibleInstances(variant);
    stats.visiblePlants += visibleCount;
    stats.culledPlants += variant.count - visibleCount;
    const triangles = variant.primitives.reduce((sum, mesh) => sum
      + (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3, 0);
    stats.fullMeshTriangles += triangles * variant.count;
    if (!variant.billboard) {
      this.#publishDetailed(variant, variant.visibleIndices, visibleCount);
      stats.near += visibleCount;
      stats.triangles += triangles * visibleCount;
      return;
    }
    const lod = variant.lod.partition(
      variant.publishedOrigins,
      variant.count,
      this.cameraPosition,
      this.lodStart.value,
      this.lodEnd.value,
      2,
      variant.visibleIndices,
      visibleCount,
    );
    stats.near += lod.nearCount;
    stats.billboards += lod.farCount;
    stats.triangles += triangles * lod.nearCount + 2 * lod.farCount;
    this.#publishDetailed(variant, lod.near, lod.nearCount);

    const mesh = variant.billboard;
    mesh.count = lod.farCount;
    if (variant.billboardSelection.matches(variant.publishedRevision, lod.far, lod.farCount)) return;
    const attributes = mesh.geometry.attributes;
    for (let i = 0; i < lod.farCount; i += 1) {
      const source = lod.far[i];
      const offset = source * 16;
      const matrices = variant.publishedMatrices;
      const originOffset = source * 3;
      const outputOffset = i * 3;
      attributes.clumpOrigin.array[outputOffset] = variant.publishedOrigins[originOffset];
      attributes.clumpOrigin.array[outputOffset + 1] = variant.publishedOrigins[originOffset + 1];
      attributes.clumpOrigin.array[outputOffset + 2] = variant.publishedOrigins[originOffset + 2];
      const scale = Math.max(
        Math.hypot(matrices[offset], matrices[offset + 2]),
        Math.hypot(matrices[offset + 8], matrices[offset + 10]),
      );
      attributes.billboardShape.setXYZ(
        i,
        variant.atlas.width * scale,
        variant.atlas.height * matrices[offset + 5],
        Math.atan2(matrices[offset + 8], matrices[offset + 10]),
      );
    }
    markAttributeUpdate(attributes.clumpOrigin, lod.farCount);
    markAttributeUpdate(attributes.billboardShape, lod.farCount);
  }

}
