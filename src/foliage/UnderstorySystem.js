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

const PLANT_ROOT_PATTERN = /^Plants_\d+$/i;

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
  constructor({ scene, renderer, camera, config, terrain, grass, jobs = null }) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.config = config;
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
    this.stats = { plants: 0, near: 0, billboards: 0, triangles: 0, fullMeshTriangles: 0 };
  }

  async init() {
    const path = this.config.assets?.foliage?.understory;
    if (!path) {
      logger.warn('Understory GLB path is not configured; skipping imported plants.');
      return this;
    }

    try {
      const gltf = await new GLTFLoader().loadAsync(assetUrl(path));
      if (this.disposed) { captureObjectResources(gltf.scene)(); return this; }
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
      logger.warn('Understory GLB failed to load; continuing without imported plants.', error);
      this.dispose();
    }
    return this;
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
    if (!this.ready) return;
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
    if ((this.lodElapsed >= 0.1 && !this.cameraPosition.equals(this.lodPosition))
      || this.cameraPosition.distanceToSquared(this.lodPosition) > 1) {
      this.#updateLod();
    }
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
      variant.atlas?.target.dispose();
    }
    this.meshes.length = 0;
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.clear();
    this.variants.length = 0;
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.releaseGltf?.();
    this.releaseGltf = null;
    this.ready = false;
  }

  #settings() {
    return resolveUnderstorySettings(this.config, this.presetName, this.qualityName);
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
      const variant = { primitives: [], count: 0, height: plant.height };
      this.variants.push(variant);
      if (this.renderer) {
        for (const primitive of plant.primitives) prepareAtlas(primitive.sourceMaterial?.map);
        variant.atlas = await bakeUnderstoryBillboard(this.renderer, plant);
        if (this.disposed) { variant.atlas.target.dispose(); return; }
        variant.billboard = createUnderstoryBillboard({ ...shared, atlas: variant.atlas, capacity,
          lodStart: this.lodStart, lodEnd: this.lodEnd });
        variant.billboard.name = `Understory billboard ${plant.name}`;
        this.scene.add(variant.billboard);
      }
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
          coverage: variant.billboard ? understoryCoverage(this.lodStart, this.lodEnd).near : null,
        });
        this.materials.push(material);
        primitive.geometry.setAttribute(
          'clumpOrigin',
          new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
        );
        const mesh = new THREE.InstancedMesh(primitive.geometry, material, capacity);
        mesh.name = `Understory ${plant.name}`;
        mesh.count = 0;
        mesh.frustumCulled = true;
        mesh.receiveShadow = true;
        mesh.castShadow = settings.castShadow;
        mesh.userData.excludeFromReflection = true;
        mesh.userData.rainRoughness = 0.4;
        this.scene.add(mesh);
        this.meshes.push(mesh);
        variant.primitives.push(mesh);
      }
      variant.matrices = new Float32Array(capacity * 16);
      variant.origins = new Float32Array(capacity * 3);
      variant.publishedMatrices = new Float32Array(capacity * 16);
      variant.publishedOrigins = new Float32Array(capacity * 3);
      variant.lod = new UnderstoryLod(capacity);
      variant.stagingCount = 0;
    }
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
    for (const variant of this.variants) {
      this.#prepareVariantBounds(variant);
      yield undefined;
    }
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

  #prepareVariantBounds(variant) {
    const padding = Math.max(variant.height, 1) * 1.4;
    const matrix = this.boundMatrix ??= new THREE.Matrix4();
    const local = this.boundLocal ??= new THREE.Box3();
    variant.primitiveBounds = variant.primitives.map((mesh) => {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const world = new THREE.Box3();
      for (let i = 0; i < variant.stagingCount; i += 1) {
        matrix.fromArray(variant.matrices, i * 16);
        local.copy(mesh.geometry.boundingBox).applyMatrix4(matrix);
        world.union(local);
      }
      if (variant.stagingCount > 0) world.expandByScalar(padding);
      const sphere = new THREE.Sphere();
      if (!world.isEmpty()) world.getBoundingSphere(sphere);
      return { box: world, sphere };
    });
  }

  #publishStaging() {
    for (const variant of this.variants) {
      const count = variant.stagingCount;
      variant.count = count;
      variant.publishedMatrices.set(variant.matrices.subarray(0, count * 16));
      variant.publishedOrigins.set(variant.origins.subarray(0, count * 3));
      for (const [index, mesh] of variant.primitives.entries()) {
        mesh.instanceMatrix.array.set(variant.matrices.subarray(0, count * 16));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.geometry.attributes.clumpOrigin.array.set(variant.origins.subarray(0, count * 3));
        mesh.geometry.attributes.clumpOrigin.needsUpdate = true;
        mesh.count = count;
        const bounds = variant.primitiveBounds?.[index];
        if (bounds) {
          mesh.boundingBox = bounds.box;
          mesh.boundingSphere = bounds.sphere;
        } else {
          mesh.computeBoundingBox();
          const padding = Math.max(variant.height, 1) * 1.4;
          mesh.boundingBox?.expandByScalar(padding);
          mesh.boundingSphere ??= new THREE.Sphere();
          mesh.boundingBox?.getBoundingSphere(mesh.boundingSphere);
        }
      }
      if (variant.billboard) {
        // A sphere covering all plants is conservative for every camera-facing
        // orientation, including the overlap while the CPU partition catches up.
        variant.billboard.boundingBox = new THREE.Box3();
        for (const bounds of variant.primitiveBounds ?? []) variant.billboard.boundingBox.union(bounds.box);
        variant.billboard.boundingSphere = new THREE.Sphere();
        if (!variant.billboard.boundingBox.isEmpty()) {
          variant.billboard.boundingBox.expandByScalar(Math.max(variant.atlas.width, variant.atlas.height));
          variant.billboard.boundingBox.getBoundingSphere(variant.billboard.boundingSphere);
        }
      }
    }
    this.camera?.getWorldPosition(this.cameraPosition);
    this.#updateLod();
  }

  #updateLod() {
    this.lodElapsed = 0;
    this.lodPosition.copy(this.cameraPosition);
    const stats = this.stats;
    for (const key of Object.keys(stats)) stats[key] = 0;
    for (const variant of this.variants) {
      stats.plants += variant.count;
      const triangles = variant.primitives.reduce((sum, mesh) => sum
        + (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3, 0);
      stats.fullMeshTriangles += triangles * variant.count;
      if (!variant.billboard) { stats.near += variant.count; stats.triangles += triangles * variant.count; continue; }
      const lod = variant.lod.partition(variant.publishedOrigins, variant.count, this.cameraPosition,
        this.lodStart.value, this.lodEnd.value);
      stats.near += lod.nearCount; stats.billboards += lod.farCount;
      stats.triangles += triangles * lod.nearCount + 2 * lod.farCount;
      for (const mesh of variant.primitives) {
        for (let i = 0; i < lod.nearCount; i++) {
          const source = lod.near[i];
          mesh.instanceMatrix.array.set(variant.publishedMatrices.subarray(source * 16, source * 16 + 16), i * 16);
          mesh.geometry.attributes.clumpOrigin.array.set(variant.publishedOrigins.subarray(source * 3, source * 3 + 3), i * 3);
        }
        mesh.count = lod.nearCount;
        mesh.instanceMatrix.needsUpdate = mesh.geometry.attributes.clumpOrigin.needsUpdate = true;
      }
      const mesh = variant.billboard, attributes = mesh.geometry.attributes;
      for (let i = 0; i < lod.farCount; i++) {
        const source = lod.far[i], offset = source * 16, m = variant.publishedMatrices;
        attributes.clumpOrigin.array.set(variant.publishedOrigins.subarray(source * 3, source * 3 + 3), i * 3);
        const scale = Math.max(Math.hypot(m[offset], m[offset + 2]), Math.hypot(m[offset + 8], m[offset + 10]));
        attributes.billboardShape.setXYZ(i, variant.atlas.width * scale, variant.atlas.height * m[offset + 5],
          Math.atan2(m[offset + 8], m[offset + 10]));
      }
      mesh.count = lod.farCount;
      attributes.clumpOrigin.needsUpdate = attributes.billboardShape.needsUpdate = true;
    }
  }
}
