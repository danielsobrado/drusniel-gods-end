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
import { createWeatheredRockMaterial } from './rockWeathering.js';
import { DRAW_ORDER, setOpaqueDrawOrder } from '../rendering/drawOrder.js';
import { adoptInstanceMatrices } from '../rendering/instanceMatrices.js';

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

// Every placed stone and lantern used to be a scene clone, one draw per placed
// part: 121 stones and 20 five-part lanterns were ~220 draws a frame of meshes
// of 6-2400 triangles, pure CPU submission cost. Placements now collect into
// one InstancedMesh per template part (11 rock shapes + 15 lantern parts).
class PropInstances {
  constructor() { this.parts = new Map(); }

  // `part` is a template mesh; `matrix` its world matrix for this placement.
  add(part, matrix) {
    let entry = this.parts.get(part);
    if (!entry) { entry = { part, matrices: [] }; this.parts.set(part, entry); }
    entry.matrices.push(matrix.clone());
  }

  mount(scene) {
    const meshes = [];
    for (const { part, matrices } of this.parts.values()) {
      const mesh = adoptInstanceMatrices(new THREE.InstancedMesh(part.geometry, part.material, matrices.length));
      matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.name = part.name;
      setOpaqueDrawOrder(mesh, DRAW_ORDER.props);
      mesh.castShadow = part.castShadow;
      mesh.receiveShadow = part.receiveShadow;
      mesh.userData.rainRoughness = part.userData.rainRoughness;
      // Bounds over every placement, so the whole set culls when out of view.
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      scene.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }
}

const placement = new THREE.Object3D();

function placeStone(instances, source, record, collisionSystem) {
  if (!Array.isArray(record) || record.length < 5) return null;
  const [x, y, z, rotationY, scale] = record;
  placement.position.set(Number(x), Number(y), Number(z));
  placement.rotation.set(0, Number(rotationY), 0);
  placement.scale.setScalar(Number(scale));
  placement.updateMatrixWorld(true);
  if (collisionSystem) {
    // The hull still comes from a placed object; it just never joins the scene.
    const probe = source.clone();
    probe.position.copy(placement.position);
    probe.rotation.copy(placement.rotation);
    probe.scale.copy(placement.scale);
    // Rocks dither away in front of the character (rockWeathering), so the
    // camera boom passes through them like trees instead of snapping in.
    collisionSystem.addConvexHullFromObject(probe, { cameraTransparent: true });
  }
  instances.add(source, placement.matrixWorld);
  return {
    name: source.name,
    position: placement.position.clone(),
    radius: (source.geometry?.boundingSphere?.radius ?? 1) * Number(scale),
  };
}

function placeLantern(instances, source, parts, record, collisionSystem) {
  if (!Array.isArray(record) || record.length < 4) return null;
  const [x, y, z, rotationY] = record;
  // Matches the old clone: the source's own scale and tilt, with Y replaced.
  placement.position.set(Number(x), Number(y), Number(z));
  placement.rotation.copy(source.rotation);
  placement.rotation.y = Number(rotationY);
  placement.scale.copy(source.scale);
  placement.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4();
  for (const { mesh, local } of parts) instances.add(mesh, matrix.multiplyMatrices(placement.matrixWorld, local));
  collisionSystem?.addBox(
    new THREE.Vector3(Number(x), Number(y) + LANTERN_COLLIDER_Y_OFFSET, Number(z)),
    LANTERN_COLLIDER_SIZE,
  );
  return { name: source.name, position: placement.position.clone(), radius: 1 };
}

// Each mesh of a lantern source with its matrix relative to the source root.
function lanternParts(source) {
  source.updateWorldMatrix(true, true);
  const inverse = source.matrixWorld.clone().invert();
  const parts = [];
  source.traverse((object) => {
    if (object.isMesh) parts.push({ mesh: object, local: new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld) });
  });
  return parts;
}

export class WorldPropSystem {
  constructor({ scene, terrainRoot, config, data, collisionSystem = null }) {
    this.scene = scene;
    this.terrainRoot = terrainRoot;
    this.config = config;
    this.data = data;
    this.collisionSystem = collisionSystem;
    // Lightweight { name, position, radius } records, one per placement, for
    // systems that avoid props (biome placement); the draws are in `meshes`.
    this.instances = [];
    this.meshes = [];
    this.ownedGeometries = [];
    this.ownedMaterials = [];
    this.pebbleSources = [];
    this.stoneSources = [];
  }

  init() {
    if (!this.terrainRoot) return this;

    const propConfig = this.config.props ?? {};
    const lanternNames = propConfig.lanternSourceNames ?? [propConfig.lanternSourceName ?? 'Lantern'];
    const lanternSources = lanternNames.map(name => this.terrainRoot.getObjectByName(name)).filter(Boolean);
    const stoneSources = this.#createStoneSources(propConfig);
    const instances = new PropInstances();

    if (stoneSources.length > 0) {
      for (const [index, record] of (this.data?.stones ?? []).entries()) {
        const instance = placeStone(instances, stoneSources[index % stoneSources.length], record, this.collisionSystem);
        if (instance) this.instances.push(instance);
      }
    } else {
      logger.warn('Stone source was not found in terrain GLB.');
    }

    if (lanternSources.length) {
      for (const source of lanternSources) prepareSource(source, propConfig);
      const partsBySource = new Map(lanternSources.map((source) => [source, lanternParts(source)]));
      for (const [index, record] of (this.data?.lanterns ?? []).entries()) {
        const source = lanternSources[Math.floor(index / 2) % lanternSources.length];
        const instance = placeLantern(instances, source, partsBySource.get(source), record, this.collisionSystem);
        if (instance) this.instances.push(instance);
      }
      for (const source of lanternSources) { source.visible = false; source.userData.skipWarmup = true; }
    } else {
      logger.warn('Lantern source was not found in terrain GLB.');
    }
    this.meshes = instances.mount(this.scene);

    logger.info('World props initialized.', {
      stones: this.data?.stones?.length ?? 0,
      stoneVariants: stoneSources.length,
      pebbles: this.pebbleSources.length,
      lanterns: this.data?.lanterns?.length ?? 0,
      draws: this.meshes.length,
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
      if (canonicalMaterial && this.config.cinematic?.enabled) {
        const weathered = createWeatheredRockMaterial(canonicalMaterial, this.config.props?.weathering, this.config);
        this.ownedMaterials.push(weathered);
        for (const root of [canonicalSource, ...rockMeshes]) {
          root?.traverse((object) => {
            if (object.isMesh) object.material = Array.isArray(object.material) ? object.material.map(() => weathered) : weathered;
          });
        }
      }
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
    for (const mesh of this.meshes) { this.scene.remove(mesh); mesh.dispose(); }
    this.meshes.length = 0;
    this.instances.length = 0;
    for (const geometry of this.ownedGeometries) geometry.dispose();
    this.ownedGeometries.length = 0;
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedMaterials.length = 0;
    this.pebbleSources = [];
  }
}
