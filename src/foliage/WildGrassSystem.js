import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { uniform } from 'three/tsl';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';
import { captureObjectResources } from '../utils/ResourceScope.js';
import { createWildGrassMaterial } from './wildGrassMaterial.js';
import { placeWildGrassClumps, resolveWildGrassSettings } from './wildGrassPlacement.js';

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
  constructor({ scene, config, terrain, grass }) {
    this.scene = scene;
    this.config = config;
    this.terrain = terrain;
    this.grass = grass;
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
    this.lastCell = '';
  }

  setQuality(name) {
    this.qualityName = name;
    this.#applySettings();
    this.lastCell = '';
  }

  update(delta, position, environment) {
    if (!this.ready) return;
    const settings = this.#settings();
    const grass = environment?.grass?.blade;
    if (grass) {
      this.windIntensity.value = Number(grass.windIntensity) || 0;
    }
    if (!settings.enabled || settings.candidatesPerCell <= 0 || settings.radius <= 0) {
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
    this.#populate(position, settings);
  }

  dispose() {
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
      this.variants.push(variant);
    }
  }

  #populate(origin, settings) {
    this.#clearInstances();
    const waterY = (this.config.water?.position?.[1] ?? 0) - 0.1;
    const clumps = placeWildGrassClumps({
      origin,
      settings,
      variantCount: this.variants.length,
      sampleEcology: (x, z) => this.grass.sampleVegetation(x, z),
      contains: (x, z) => this.terrain.contains(x, z, 2),
      sampleHeight: (x, z) => this.terrain.sampleHeight(x, z),
      waterY,
    });
    clumps.sort((a, b) => {
      const da = (a.x - origin.x) ** 2 + (a.z - origin.z) ** 2;
      const db = (b.x - origin.x) ** 2 + (b.z - origin.z) ** 2;
      return da - db;
    });

    for (const clump of clumps) {
      const variant = this.variants[clump.variant];
      if (!variant?.primitives.length || variant.count >= variant.primitives[0].instanceMatrix.count) continue;
      const index = variant.count++;
      this.dummy.position.set(clump.x, clump.y, clump.z);
      this.dummy.rotation.set(0, clump.yaw, 0);
      this.dummy.scale.set(clump.scaleX, clump.scaleY, clump.scaleZ);
      this.dummy.updateMatrix();
      for (const mesh of variant.primitives) {
        mesh.setMatrixAt(index, this.dummy.matrix);
        mesh.geometry.attributes.clumpOrigin.setXYZ(index, clump.x, clump.y, clump.z);
      }
    }

    for (const variant of this.variants) {
      for (const mesh of variant.primitives) {
        mesh.count = variant.count;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.geometry.attributes.clumpOrigin.needsUpdate = true;
        mesh.computeBoundingBox();
        const padding = Math.max(variant.height, 1) * 1.4;
        mesh.boundingBox?.expandByScalar(padding);
        mesh.boundingSphere ??= new THREE.Sphere();
        mesh.boundingBox?.getBoundingSphere(mesh.boundingSphere);
      }
    }
  }
}
