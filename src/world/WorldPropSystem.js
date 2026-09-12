import * as THREE from 'three';
import { logger } from '../utils/logger.js';
import {
  bakeRockTemplate,
  canonicalizeRockMaterials,
  classifyRockTemplates,
  collectRockMeshes,
  DEFAULT_PEBBLE_MAX_SIZE,
  DEFAULT_STONE_PACK_SCALE,
  harmonizeRockMaterials,
  hideRockPack,
  scaleRockTemplate,
} from './rockPack.js';

const DEFAULT_ANISOTROPY = 16;
const DEFAULT_RAIN_ROUGHNESS = 0.1;
const LANTERN_COLLIDER_Y_OFFSET = 2.5;
const LANTERN_COLLIDER_SIZE = new THREE.Vector3(1.8, 5, 1.8);
const MATERIAL_TEXTURES = Object.freeze([
  ['map', THREE.SRGBColorSpace],
  ['normalMap', THREE.NoColorSpace],
  ['roughnessMap', THREE.NoColorSpace],
  ['aoMap', THREE.NoColorSpace],
]);

function prepareTexture(texture, anisotropy, colorSpace) {
  if (!texture) return;
  texture.colorSpace = colorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
}

function prepareMesh(mesh, config) {
  mesh.userData.rainRoughness = config.rainRoughness ?? DEFAULT_RAIN_ROUGHNESS;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials.filter(Boolean)) {
    for (const [key, colorSpace] of MATERIAL_TEXTURES) {
      prepareTexture(material[key], config.anisotropy ?? DEFAULT_ANISOTROPY, colorSpace);
    }
  }
}

function prepareSource(source, config) {
  if (!source) return;
  if (source.traverse) {
    source.traverse((object) => {
      if (object.isMesh) prepareMesh(object, config);
    });
    return;
  }
  if (source.isMesh) prepareMesh(source, config);
}

function createStone(scene, source, record, collisionSystem) {
  if (!Array.isArray(record) || record.length < 5) return null;
  const [x, y, z, rotationY, scale] = record;
  const stone = source.clone();
  stone.position.set(Number(x), Number(y), Number(z));
  stone.rotation.y = Number(rotationY);
  stone.scale.setScalar(Number(scale));
  collisionSystem?.addConvexHullFromObject(stone);
  scene.add(stone);
  return stone;
}

function createLantern(scene, source, record, collisionSystem) {
  if (!Array.isArray(record) || record.length < 4) return null;
  const [x, y, z, rotationY] = record;
  const lantern = source.clone();
  lantern.position.set(Number(x), Number(y), Number(z));
  lantern.rotation.y = Number(rotationY);
  collisionSystem?.addBox(
    new THREE.Vector3(Number(x), Number(y) + LANTERN_COLLIDER_Y_OFFSET, Number(z)),
    LANTERN_COLLIDER_SIZE,
  );
  scene.add(lantern);
  return lantern;
}

export class WorldPropSystem {
  constructor({ scene, terrainRoot, config, data, collisionSystem = null }) {
    this.scene = scene;
    this.terrainRoot = terrainRoot;
    this.config = config;
    this.data = data;
    this.collisionSystem = collisionSystem;
    this.instances = [];
    this.ownedGeometries = [];
    this.ownedMaterials = [];
    this.pebbleSources = [];
    this.stoneSources = [];
  }

  init() {
    if (!this.terrainRoot) return this;

    const propConfig = this.config.props ?? {};
    const lanternSource = this.terrainRoot.getObjectByName(propConfig.lanternSourceName ?? 'Lantern');
    const stoneSources = this.#createStoneSources(propConfig);

    if (stoneSources.length > 0) {
      for (const [index, record] of (this.data?.stones ?? []).entries()) {
        const instance = createStone(
          this.scene,
          stoneSources[index % stoneSources.length],
          record,
          this.collisionSystem,
        );
        if (instance) this.instances.push(instance);
      }
    } else {
      logger.warn('Recovered Stone source was not found in terrain GLB.');
    }

    if (lanternSource) {
      prepareSource(lanternSource, propConfig);
      for (const record of this.data?.lanterns ?? []) {
        const instance = createLantern(this.scene, lanternSource, record, this.collisionSystem);
        if (instance) this.instances.push(instance);
      }
    } else {
      logger.warn('Recovered Lantern source was not found in terrain GLB.');
    }

    logger.info('Recovered world props initialized.', {
      stones: this.data?.stones?.length ?? 0,
      stoneVariants: stoneSources.length,
      pebbles: this.pebbleSources.length,
      lanterns: this.data?.lanterns?.length ?? 0,
    });
    return this;
  }

  #createStoneSources(propConfig) {
    const canonicalSourceName = propConfig.rockMaterialSourceName
      ?? propConfig.stoneSourceName
      ?? 'Stone';
    const canonicalSource = this.terrainRoot.getObjectByName(canonicalSourceName);
    if (canonicalSource) prepareSource(canonicalSource, propConfig);

    const rockMeshes = collectRockMeshes(this.terrainRoot);
    if (rockMeshes.length > 0) {
      const canonicalMaterial = canonicalSource
        ? canonicalizeRockMaterials(rockMeshes, canonicalSource)
        : harmonizeRockMaterials(rockMeshes);
      if (canonicalSource && canonicalMaterial) this.ownedMaterials.push(canonicalMaterial);
      for (const mesh of rockMeshes) prepareSource(mesh, propConfig);
      hideRockPack(rockMeshes);
      const templates = rockMeshes.map((mesh) => bakeRockTemplate(mesh));
      const { stones, pebbles } = classifyRockTemplates(
        templates,
        propConfig.pebbleMaxSize ?? DEFAULT_PEBBLE_MAX_SIZE,
      );
      const packScale = propConfig.stonePackScale ?? DEFAULT_STONE_PACK_SCALE;
      for (const stone of stones) scaleRockTemplate(stone, packScale);
      this.ownedGeometries.push(...templates.map((template) => template.geometry));
      this.pebbleSources = pebbles;
      this.stoneSources = stones;
      return stones.length > 0 ? stones : templates;
    }

    if (!canonicalSource) return [];
    prepareSource(canonicalSource, propConfig);
    return [canonicalSource];
  }

  dispose() {
    for (const instance of this.instances) this.scene.remove(instance);
    this.instances.length = 0;
    for (const geometry of this.ownedGeometries) geometry.dispose();
    this.ownedGeometries.length = 0;
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedMaterials.length = 0;
    this.pebbleSources = [];
  }
}
