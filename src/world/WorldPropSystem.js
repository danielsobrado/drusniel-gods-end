import * as THREE from 'three';
import { logger } from '../utils/logger.js';

const DEFAULT_ANISOTROPY = 16;
const DEFAULT_RAIN_ROUGHNESS = 0.1;
const LANTERN_COLLIDER_Y_OFFSET = 2.5;
const LANTERN_COLLIDER_SIZE = new THREE.Vector3(1.8, 5, 1.8);

function textureFromSource(source) {
  const material = Array.isArray(source?.material) ? source.material[0] : source?.material;
  return material?.map ?? null;
}

function prepareTexture(texture, anisotropy) {
  if (!texture) return;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
}

function prepareSource(source, config) {
  if (!source) return;
  source.userData.rainRoughness = config.rainRoughness ?? DEFAULT_RAIN_ROUGHNESS;
  prepareTexture(textureFromSource(source), config.anisotropy ?? DEFAULT_ANISOTROPY);
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
  }

  init() {
    if (!this.terrainRoot) return this;

    const propConfig = this.config.props ?? {};
    const stoneSource = this.terrainRoot.getObjectByName(propConfig.stoneSourceName ?? 'Stone');
    const lanternSource = this.terrainRoot.getObjectByName(propConfig.lanternSourceName ?? 'Lantern');

    if (stoneSource) {
      prepareSource(stoneSource, propConfig);
      for (const record of this.data?.stones ?? []) {
        const instance = createStone(this.scene, stoneSource, record, this.collisionSystem);
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
      lanterns: this.data?.lanterns?.length ?? 0,
    });
    return this;
  }

  dispose() {
    for (const instance of this.instances) this.scene.remove(instance);
    this.instances.length = 0;
  }
}
