import { capPopulation } from './populationCap.js';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { uniform } from 'three/tsl';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';
import { captureObjectResources } from '../utils/ResourceScope.js';
import { createWildGrassMaterial } from './wildGrassMaterial.js';
import { VegetationJob, VegetationSampleCache } from './vegetationRebuild.js';
import { iterateWildGrassClumps, resolveWildGrassSettings } from './wildGrassPlacement.js';

const ANISOTROPY = 8;

function meshMaterial(source) {
  return Array.isArray(source?.material) ? source.material[0] : source?.material;
}

function prepareMap(texture) {
  if (!texture) return;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = ANISOTROPY;
  texture.needsUpdate = true;
}

function collectClumpRoots(scene) {
  const roots = [];
  const rootNode = scene.getObjectByName('RootNode') ?? scene;
  for (const child of rootNode.children) {
    let meshes = 0;
    child.traverse((object) => {
      if (object.isMesh && object.geometry) meshes += 1;
    });
    if (meshes >= 2) roots.push(child);
  }
  if (roots.length > 0) return roots;
  const singles = [];
  scene.traverse((object) => {
    if (object.isMesh && object.geometry) singles.push(object);
  });
  return singles;
}

function bakeClump(root, worldScale = 1) {
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

export class WildGrassSystem {
  constructor({ scene, config, terrain, grass, jobs = null }) {
    this.scene = scene;
    this.config = config;
    this.terrain = terrain;
    this.grass = grass;
    this.jobs = jobs;
    this.jobId = 'wildGrass';
    this.populateGeneration = 0;
    this.sampleCache = new VegetationSampleCache();
    this.presetName = config.ui?.initialPreset;
    this.qualityName = config.ui?.initialQuality;
    this.variants = [];
    this.meshes = [];
    this.materials = [];
    this.releaseGltf = null;
    this.lastCell = '';
    this.dummy = new THREE.Object3D();
    this.ready = false;
    this.radius = uniform(0);
    this.fadeWidth = uniform(16);
    this.windIntensity = uniform(0.2);
    this.windBend = uniform(0.11);
    this.windFlutter = uniform(0.028);
  }

  async init() {
    const path = this.config.assets?.foliage?.wildGrass;
    if (!path) {
      logger.warn('Wild grass GLB path is not configured; skipping imported foliage.');
      return this;
    }

    try {
      const gltf = await new GLTFLoader().loadAsync(assetUrl(path));
      this.releaseGltf = captureObjectResources(gltf.scene);
      gltf.scene.updateMatrixWorld(true);
      const worldScale = this.#settings().worldScale ?? 1;
      const clumps = collectClumpRoots(gltf.scene)
        .map((root) => bakeClump(root, worldScale))
        .filter(Boolean);
      if (clumps.length === 0) {
        logger.warn('Wild grass GLB contained no usable clump meshes; skipping imported foliage.');
        this.releaseGltf?.();
        this.releaseGltf = null;
        return this;
      }
      this.#createInstances(clumps);
      this.ready = true;
      this.#applySettings();
      logger.info('Wild grass foliage initialized.', {
        variants: this.variants.length,
        primitives: this.meshes.length,
      });
    } catch (error) {
      logger.warn('Wild grass GLB failed to load; continuing without imported foliage.', error);
      this.releaseGltf?.();
      this.releaseGltf = null;
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
    const cell = `${Math.floor(position.x / cellSize)},${Math.floor(position.z / cellSize)}`;
    if (cell === this.lastCell) return;
    this.lastCell = cell;
    this.#startPopulate(position, settings);
  }

  dispose() {
    this.jobs?.cancel(this.jobId);
    this.sampleCache.clear();
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.meshes.length = 0;
    this.variants.length = 0;
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.releaseGltf?.();
    this.releaseGltf = null;
    this.ready = false;
  }

  #settings() {
    return resolveWildGrassSettings(this.config, this.presetName, this.qualityName);
  }

  #applySettings() {
    const settings = this.#settings();
    this.radius.value = settings.radius;
    this.fadeWidth.value = settings.fadeWidth;
    this.windBend.value = settings.windBend;
    this.windFlutter.value = settings.windFlutter;
    for (const mesh of this.meshes) mesh.castShadow = settings.castShadow;
  }

  #clearInstances() {
    for (const mesh of this.meshes) mesh.count = 0;
    for (const variant of this.variants) variant.count = 0;
  }

  #createInstances(clumps) {
    const settings = this.#settings();
    const cinematic = Boolean(this.config.cinematic?.enabled);
    const capacity = Math.max(1, settings.count ?? 1200);
    const shared = {
      radius: this.radius,
      fadeWidth: this.fadeWidth,
      windIntensity: this.windIntensity,
      windBend: this.windBend,
      windFlutter: this.windFlutter,
      cinematic,
      config: this.config,
    };

    for (const clump of clumps) {
      const variant = { primitives: [], count: 0, height: clump.height };
      const height = uniform(clump.height);
      for (const primitive of clump.primitives) {
        const source = primitive.sourceMaterial;
        prepareMap(source?.map);
        const material = createWildGrassMaterial({
          ...shared,
          map: source?.map ?? null,
          color: source?.color,
          roughness: source?.roughness ?? 0.82,
          metalness: source?.metalness ?? 0,
          height,
          alphaTest: settings.alphaTest,
          shadowAlphaTest: settings.shadowAlphaTest,
        });
        this.materials.push(material);
        primitive.geometry.setAttribute(
          'clumpOrigin',
          new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
        );
        const mesh = new THREE.InstancedMesh(primitive.geometry, material, capacity);
        mesh.name = `WildGrass ${clump.name}`;
        mesh.count = 0;
        mesh.frustumCulled = true;
        mesh.receiveShadow = true;
        mesh.castShadow = settings.castShadow;
        mesh.userData.excludeFromReflection = true;
        mesh.userData.rainRoughness = 0.35;
        this.scene.add(mesh);
        this.meshes.push(mesh);
        variant.primitives.push(mesh);
      }
      variant.matrices = new Float32Array(capacity * 16);
      variant.origins = new Float32Array(capacity * 3);
      variant.stagingCount = 0;
      this.variants.push(variant);
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
    const generate = () => iterateWildGrassClumps({
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
      for (const clump of generate()) {
        if (clump) this.pending.push(clump);
      }
      Array.from(this.#finalizePopulate(origin));
      publish();
      return;
    }
    this.jobs.replace(this.jobId, new VegetationJob({
      generate,
      consume: (clump) => this.pending.push(clump),
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
      this.#stageClump(this.pending[i]);
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

  #stageClump(clump) {
    const variant = this.variants[clump.variant];
    if (!variant?.primitives.length || !variant.matrices) return;
    const capacity = variant.matrices.length / 16;
    if (variant.stagingCount >= capacity) return;
    const index = variant.stagingCount++;
    this.dummy.position.set(clump.x, clump.y, clump.z);
    this.dummy.rotation.set(0, clump.yaw, 0);
    this.dummy.scale.set(clump.scaleX, clump.scaleY, clump.scaleZ);
    this.dummy.updateMatrix();
    this.dummy.matrix.toArray(variant.matrices, index * 16);
    variant.origins[index * 3] = clump.x;
    variant.origins[index * 3 + 1] = clump.y;
    variant.origins[index * 3 + 2] = clump.z;
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
    }
  }
}
