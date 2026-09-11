import { getPresetAppearance } from '../rendering/PresetAppearance.js';
import * as THREE from 'three/webgpu';
import { attribute, texture, uv, vec3, vec4 } from 'three/tsl';
import { adventureCanopyColor } from '../rendering/AdventurePalette.js';
import { foliageLight } from '../rendering/CinematicLighting.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { createRandom } from '../utils/random.js';
import { logger } from '../utils/logger.js';
import { TreeLeafMaterialFactory } from './TreeLeafMaterial.js';

const LOD_HIGH = 0;
const LOD_BILLBOARD = 1;
const LOD_HIDDEN = 2;
const BILLBOARD_ALPHA_TEST = 0.4;
const BILLBOARD_ANISOTROPY = 16;
const MIN_TRANSITION_SECONDS = 0.001;
const TREE_RAIN_ROUGHNESS = 0.4;
const DEFAULT_UPDATE_SECONDS = 1 / 60;

function materialsOf(material) {
  return Array.isArray(material) ? material : [material];
}

function cloneHighMaterial(material) {
  const cloneMaterial = material.clone();
  cloneMaterial.alphaHash = true;
  cloneMaterial.transparent = false;
  cloneMaterial.depthWrite = true;
  cloneMaterial.opacity = 1;
  return cloneMaterial;
}

function collectMaterials(root) {
  const materials = [];
  root.traverse((object) => {
    if (!object.isMesh || !object.material) return;
    materials.push(...materialsOf(object.material));
  });
  return materials;
}

function prepareTreeClone(root, source, leafMaterialFactory) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.visible = true;
    object.frustumCulled = true;
    object.geometry.computeBoundingSphere();
    object.boundingSphere = object.geometry.boundingSphere.clone();
    // Per-object bounds leave the shared source geometry untouched. Allow
    // generous shader wind movement so canopy tips never pop at the edge.
    if (source.highLeavesName && object.name === source.highLeavesName) {
      object.boundingSphere.radius += 10;
      object.userData.occlusionPadding = 10;
    }
    object.castShadow = true;
    object.receiveShadow = true;
    object.userData.rainRoughness = TREE_RAIN_ROUGHNESS;

    if (source.highLeavesName && object.name === source.highLeavesName) {
      object.material = leafMaterialFactory.create(object.material);
      object.material.opacity = 1;
      return;
    }

    if (!object.material) return;
    const cloned = materialsOf(object.material).map(cloneHighMaterial);
    object.material = Array.isArray(object.material) ? cloned : cloned[0];
  });
}

function setMaterialsOpacity(materials, opacity) {
  for (const material of materials) material.opacity = opacity;
}

function findFirstMesh(root) {
  let mesh = null;
  root?.traverse((object) => {
    if (!mesh && object.isMesh) mesh = object;
  });
  return mesh;
}

function bakeBillboardGeometry(root, mesh) {
  root.updateWorldMatrix(true, true);
  mesh.updateWorldMatrix(true, true);
  const geometry = mesh.geometry.clone();
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createBillboardMaterial(sourceMaterial, opacityAttributeName, config) {
  const material = new THREE.MeshStandardNodeMaterial();
  material.map = sourceMaterial?.map ?? null;
  if (material.map) {
    material.map.minFilter = THREE.LinearMipmapLinearFilter;
    material.map.magFilter = THREE.LinearFilter;
    material.map.anisotropy = BILLBOARD_ANISOTROPY;
  }
  material.color.copy(sourceMaterial?.color ?? new THREE.Color(1, 1, 1));
  material.side = THREE.DoubleSide;
  material.transparent = false;
  material.depthWrite = true;
  material.alphaTest = BILLBOARD_ALPHA_TEST;
  material.alphaToCoverage = Boolean(config.cinematic?.enabled);
  material.opacityNode = attribute(opacityAttributeName, 'float');
  material.normalNode = vec3(0, 1, 0);
  if (config.cinematic?.enabled && config.cinematic.style?.enabled && material.map) {
    const leafSample = texture(material.map, uv());
    const canopy = adventureCanopyColor(leafSample.rgb, config);
    material.colorNode = vec4(canopy, leafSample.a);
    material.emissiveNode = canopy.mul(foliageLight.fill).mul(getPresetAppearance(config).foliageFill);
  }
  return material;
}

function smoothStep01(value) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export class TreeSystem {
  constructor({ scene, camera, terrainRoot, zoneIndex, config, worldData = null, fallbackFactory }) {
    this.scene = scene;
    this.camera = camera;
    this.root = terrainRoot;
    this.zoneIndex = zoneIndex;
    this.config = config;
    this.worldData = Array.isArray(worldData) ? worldData : null;
    this.fallbackFactory = fallbackFactory;
    this.trees = [];
    this.transitioningTrees = new Set();
    this.sources = [];
    this.billboardGroups = [];
    this.random = createRandom(0x71ee5);
    this.cameraPosition = new THREE.Vector3();
    this.lodUpdateTimer = 0;
    this.leafMaterialFactory = new TreeLeafMaterialFactory(config);
  }

  init() {
    if (!this.root) {
      logger.warn('Terrain GLB is unavailable; using procedural tree fallback.');
      this.fallbackFactory?.();
      return this;
    }

    this.#setupSources();
    if (this.worldData?.length) this.#createTreesFromWorldData();
    else this.#createTreesFromMarkers();

    this.#buildBillboards();
    this.#hideSourceObjects();

    logger.info('Tree system initialized.', {
      trees: this.trees.length,
      sources: this.sources.filter(Boolean).length,
      worldData: Boolean(this.worldData?.length),
      billboards: this.billboardGroups.length,
    });

    if (this.trees.length === 0) {
      logger.warn('No tree instances could be built from the GLB; using procedural tree fallback.');
      this.fallbackFactory?.();
    }
    return this;
  }

  #setupSources() {
    this.sources = this.config.trees.types.map((definition, typeIndex) => {
      const high = this.root.getObjectByName(definition.high);
      const low = this.root.getObjectByName(definition.low);
      const highLeavesName = definition.highLeaves ?? definition.leaves ?? null;
      const highLeaves = highLeavesName ? this.root.getObjectByName(highLeavesName) : null;
      if (!high || !low) {
        logger.warn('Tree source is incomplete.', { typeIndex, high: definition.high, low: definition.low });
        return null;
      }
      if (highLeavesName && !highLeaves) {
        logger.warn('Tree leaf source is missing.', { typeIndex, highLeaves: highLeavesName });
      }

      const billboardMesh = findFirstMesh(low);
      if (!billboardMesh?.material) {
        logger.warn('Tree billboard source has no mesh/material.', { typeIndex, low: definition.low });
        return null;
      }

      high.visible = false;
      low.visible = false;
      if (highLeaves) highLeaves.visible = false;

      return {
        ...definition,
        high,
        low,
        highLeavesName,
        billboardGeometry: bakeBillboardGeometry(low, billboardMesh),
        billboardSourceMaterial: materialsOf(billboardMesh.material)[0],
        billboardGroup: null,
      };
    });
  }

  #createTreesFromWorldData() {
    this.worldData.forEach((record, index) => {
      if (!Array.isArray(record) || record.length < 6) return;
      const typeIndex = Number(record[5]);
      const source = this.sources[typeIndex];
      if (!source) return;
      this.#createTree({
        index,
        typeIndex,
        source,
        position: new THREE.Vector3(Number(record[0]), Number(record[1]), Number(record[2])),
        rotation: Number(record[3]),
        scale: Number(record[4]),
        zone: source.zones?.[0] ?? source.zone ?? null,
      });
    });
  }

  #createTreesFromMarkers() {
    const markerGroup = this.root.getObjectByName(this.config.trees.positionsName);
    if (!markerGroup) {
      logger.warn('Tree markers were not found.');
      return;
    }

    markerGroup.updateWorldMatrix(true, true);
    markerGroup.children.forEach((marker, index) => {
      const position = new THREE.Vector3();
      marker.getWorldPosition(position);
      const zone = this.zoneIndex?.getZone(position) ?? null;
      const candidates = this.sources.filter((source) => {
        if (!source) return false;
        const zones = source.zones ?? (source.zone ? [source.zone] : []);
        return !zone || zones.length === 0 || zones.includes(zone);
      });
      const source = candidates[Math.floor(this.random() * candidates.length)] ?? this.sources.find(Boolean);
      if (!source) return;
      const typeIndex = this.sources.indexOf(source);
      const scale = THREE.MathUtils.lerp(this.config.trees.minScale, this.config.trees.maxScale, this.random());
      this.#createTree({
        index,
        typeIndex,
        source,
        position,
        rotation: this.random() * Math.PI * 2,
        scale,
        zone,
      });
    });
    markerGroup.visible = false;
  }

  #createTree({ index, typeIndex, source, position, rotation, scale, zone }) {
    const high = clone(source.high);
    high.name = `TreeHigh_${index}`;
    high.visible = true;
    high.position.copy(position);
    high.rotation.y = rotation;
    high.scale.setScalar(scale);
    prepareTreeClone(high, source, this.leafMaterialFactory);
    this.scene.add(high);

    this.trees.push({
      index,
      typeIndex,
      zone,
      high,
      position: high.position,
      rotation,
      scale,
      highMaterials: collectMaterials(high),
      billboardGroup: null,
      billboardIndex: -1,
      billboardOpacity: 0,
      currentLOD: LOD_HIGH,
      targetLOD: LOD_HIGH,
      transitioning: false,
      transitionTime: 0,
      transitionHighStart: 1,
      transitionBillboardStart: 0,
    });
  }

  #buildBillboards() {
    const counts = new Array(this.sources.length).fill(0);
    for (const tree of this.trees) counts[tree.typeIndex] += 1;

    this.sources.forEach((source, typeIndex) => {
      const count = counts[typeIndex];
      if (!source || count === 0) return;

      const geometry = source.billboardGeometry;
      const opacityAttributeName = `treeOpacity_${typeIndex}`;
      const opacity = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
      opacity.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(opacityAttributeName, opacity);

      const material = createBillboardMaterial(source.billboardSourceMaterial, opacityAttributeName, this.config);
      const group = new THREE.InstancedMesh(geometry, material, count);
      group.name = `TreeBillboards_${typeIndex}`;
      group.frustumCulled = false;
      group.castShadow = false;
      group.receiveShadow = false;

      const transform = new THREE.Object3D();
      let billboardIndex = 0;
      for (const tree of this.trees) {
        if (tree.typeIndex !== typeIndex) continue;
        transform.position.copy(tree.position);
        transform.rotation.set(0, tree.rotation, 0);
        transform.scale.setScalar(tree.scale);
        transform.updateMatrix();
        group.setMatrixAt(billboardIndex, transform.matrix);
        tree.billboardGroup = group;
        tree.billboardIndex = billboardIndex;
        billboardIndex += 1;
      }
      group.instanceMatrix.needsUpdate = true;
      source.billboardGroup = group;
      this.billboardGroups.push(group);
      this.scene.add(group);
    });
  }

  #hideSourceObjects() {
    for (const source of this.sources) {
      if (!source) continue;
      source.high.visible = false;
      source.low.visible = false;
    }
  }

  #setBillboardOpacity(tree, opacity) {
    tree.billboardOpacity = opacity;
    if (!tree.billboardGroup || tree.billboardIndex < 0) return;
    const attributeName = `treeOpacity_${tree.typeIndex}`;
    const opacityAttribute = tree.billboardGroup.geometry.getAttribute(attributeName);
    if (!opacityAttribute) return;
    opacityAttribute.setX(tree.billboardIndex, opacity);
    opacityAttribute.needsUpdate = true;
  }

  #horizontalDistance(position) {
    const dx = this.cameraPosition.x - position.x;
    const dz = this.cameraPosition.z - position.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  #desiredLod(tree, distance) {
    const config = this.config.trees;
    if (tree.currentLOD === LOD_HIGH) {
      return distance < config.highDistance + config.highHysteresis ? LOD_HIGH : LOD_BILLBOARD;
    }
    if (tree.currentLOD === LOD_BILLBOARD) {
      if (distance < config.highDistance - config.highHysteresis) return LOD_HIGH;
      return distance < config.billboardDistance + config.billboardHysteresis
        ? LOD_BILLBOARD
        : LOD_HIDDEN;
    }
    if (distance >= config.billboardDistance - config.billboardHysteresis) return LOD_HIDDEN;
    return distance < config.highDistance - config.highHysteresis ? LOD_HIGH : LOD_BILLBOARD;
  }

  #transition(tree, targetLOD) {
    if (!tree.transitioning && tree.currentLOD === targetLOD) return;
    tree.targetLOD = targetLOD;
    tree.transitioning = true;
    this.transitioningTrees.add(tree);
    tree.transitionTime = 0;
    tree.transitionHighStart = tree.highMaterials[0]?.opacity ?? 0;
    tree.transitionBillboardStart = tree.billboardOpacity;
    tree.high.visible = true;
  }

  #updateTransition(tree, deltaSeconds) {
    if (!tree.transitioning) return;
    tree.transitionTime += deltaSeconds;
    const duration = Math.max(this.config.trees.transitionDuration, MIN_TRANSITION_SECONDS);
    const t = smoothStep01(tree.transitionTime / duration);
    const highTarget = tree.targetLOD === LOD_HIGH ? 1 : 0;
    const billboardTarget = tree.targetLOD === LOD_BILLBOARD ? 1 : 0;
    const highOpacity = THREE.MathUtils.lerp(tree.transitionHighStart, highTarget, t);
    const billboardOpacity = THREE.MathUtils.lerp(tree.transitionBillboardStart, billboardTarget, t);
    setMaterialsOpacity(tree.highMaterials, highOpacity);
    this.#setBillboardOpacity(tree, billboardOpacity);

    if (t < 1) return;
    tree.currentLOD = tree.targetLOD;
    tree.transitioning = false;
    this.transitioningTrees.delete(tree);
    tree.transitionTime = 0;
    tree.high.visible = tree.currentLOD === LOD_HIGH;
    this.#setBillboardOpacity(tree, tree.currentLOD === LOD_BILLBOARD ? 1 : 0);
  }

  setWindSpeed(value) {
    this.leafMaterialFactory.setWindSpeed(value);
  }

  setWindStrength(value) {
    this.leafMaterialFactory.setWindStrength(value);
  }

  setSimulationSpeed(value) {
    this.leafMaterialFactory.setSimulationSpeed(value);
  }

  update(deltaSeconds = DEFAULT_UPDATE_SECONDS) {
    this.camera.getWorldPosition(this.cameraPosition);
    for (const tree of this.transitioningTrees) this.#updateTransition(tree, deltaSeconds);

    this.lodUpdateTimer += deltaSeconds;
    if (this.lodUpdateTimer < (this.config.trees.lodUpdateInterval ?? 0.1)) return;
    this.lodUpdateTimer = 0;

    for (const tree of this.trees) {
      if (tree.transitioning) continue;
      const nextLOD = this.#desiredLod(tree, this.#horizontalDistance(tree.position));
      if (nextLOD !== tree.currentLOD) this.#transition(tree, nextLOD);
    }
  }

  dispose() {
    for (const tree of this.trees) {
      this.scene.remove(tree.high);
      for (const material of tree.highMaterials) material.dispose?.();
    }
    for (const group of this.billboardGroups) {
      this.scene.remove(group);
      group.geometry?.dispose?.();
      group.material?.dispose?.();
    }
    this.trees.length = 0;
    this.sources.length = 0;
    this.billboardGroups.length = 0;
  }
}
