import * as THREE from 'three/webgpu';
import {
  attribute, color, dot, mix, positionLocal, reference, smoothstep, texture, uv, vec3, vec4,
} from 'three/tsl';
import { adventureCanopyColor } from '../rendering/AdventurePalette.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { createRandom } from '../utils/random.js';
import { logger } from '../utils/logger.js';
import { TreeLeafMaterialFactory } from './TreeLeafMaterial.js';
import { fitRootGround, measureRootReach, resolveRootSettings, rootBendFor } from './treeRootFit.js';

const LOD_HIGH = 0;
const LOD_BILLBOARD = 1;
const LOD_HIDDEN = 2;
const MIN_TRANSITION_SECONDS = 0.001;
const TREE_RAIN_ROUGHNESS = 0.4;
const DEFAULT_UPDATE_SECONDS = 1 / 60;
const TREE_HASH_SCALE = 43758.5453;

function materialsOf(material) {
  return Array.isArray(material) ? material : [material];
}

function cloneHighMaterial(material, rootSettings) {
  const cloneMaterial = material.isNodeMaterial ? material.clone()
    : new THREE.MeshStandardNodeMaterial().copy(material);
  cloneMaterial.name = `TreeBark:${material.name || material.type}`;
  cloneMaterial.alphaHash = true;
  cloneMaterial.transparent = false;
  cloneMaterial.depthWrite = true;
  cloneMaterial.opacity = 1;
  cloneMaterial.opacityNode = reference('userData.treeAppearance.opacity', 'float');
  if (rootSettings.enabled) {
    // Shear the root flare onto this tree's fitted ground plane, fading out up the trunk.
    const base = cloneMaterial.positionNode ?? positionLocal;
    const bend = reference('userData.treeRoots.bend', 'vec2');
    const weight = smoothstep(0, rootSettings.conformHeight, base.y).oneMinus();
    cloneMaterial.positionNode = base.add(vec3(0, dot(bend, base.xz).mul(weight), 0));
  }
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

function hash01(value) {
  const sample = Math.sin(value) * TREE_HASH_SCALE;
  return sample - Math.floor(sample);
}

export function resolveTreeShape(index, position, settings = {}) {
  if (settings.enabled !== true) return new THREE.Vector3(1, 1, 1);
  const seed = (index + 1) * 17.137 + position.x * 0.073 + position.z * 0.037;
  const variation = (amount, phase) => 1 + (hash01(seed + phase) * 2 - 1)
    * THREE.MathUtils.clamp(Number(amount) || 0, 0, 0.4);
  return new THREE.Vector3(variation(settings.width, 0), variation(settings.height, 31), variation(settings.depth, 67));
}

function resolveTreeAppearance(index, position, config) {
  const appearance = config.trees.appearance ?? {};
  const seed = (index + 1) * 12.9898 + position.x * 0.031 + position.z * 0.047;
  const requestedRetention = Number(appearance.retention);
  const retention = THREE.MathUtils.clamp(
    Number.isFinite(requestedRetention) ? requestedRetention : 1,
    0,
    1,
  );
  const scaleVariation = Math.max(0, Number(appearance.scaleVariation) || 0);
  const brightnessVariation = Math.max(0, Number(appearance.brightnessVariation) || 0);
  const greenVariation = Math.max(0, Number(appearance.greenVariation) || 0);
  const scale = 1 + (hash01(seed) * 2 - 1) * scaleVariation;
  const brightness = 1 + (hash01(seed + 19.17) * 2 - 1) * brightnessVariation;
  const greenShift = (hash01(seed + 47.03) * 2 - 1) * greenVariation;
  const tint = new THREE.Color(
    brightness * (1 - greenShift * 0.35),
    brightness * (1 + greenShift),
    brightness * (1 - greenShift * 0.45),
  );
  return { retained: hash01(seed + 83.19) <= retention, scale, tint };
}

function prepareTreeClone(root, source, leafMaterialFactory, appearance, roots, barkMaterials, rootSettings) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.visible = true;
    object.frustumCulled = true;
    if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
    object.boundingSphere = object.geometry.boundingSphere.clone();
    if (source.highLeavesName && object.name === source.highLeavesName) {
      object.boundingSphere.radius += 10;
      object.userData.occlusionPadding = 10;
    }
    object.castShadow = true;
    object.receiveShadow = true;
    object.userData.rainRoughness = TREE_RAIN_ROUGHNESS;
    object.userData.treeAppearance = appearance;
    object.userData.treeRoots = roots;

    if (source.highLeavesName && object.name === source.highLeavesName) {
      object.material = leafMaterialFactory.createShared(object.material);
      return;
    }

    if (!object.material) return;
    const cloned = materialsOf(object.material).map(material => {
      if (!barkMaterials.has(material)) barkMaterials.set(material, cloneHighMaterial(material, rootSettings));
      return barkMaterials.get(material);
    });
    object.material = Array.isArray(object.material) ? cloned : cloned[0];
  });
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

function createBillboardMaterial(sourceMaterial, opacityAttributeName, tintAttributeName, config) {
  const billboardConfig = config.trees.billboard;
  const material = new THREE.MeshBasicNodeMaterial();
  material.map = sourceMaterial?.map ?? null;
  if (material.map) {
    material.map.minFilter = THREE.LinearMipmapLinearFilter;
    material.map.magFilter = THREE.LinearFilter;
    material.map.anisotropy = billboardConfig.anisotropy;
  }
  material.color.copy(sourceMaterial?.color ?? new THREE.Color(1, 1, 1));
  material.side = THREE.DoubleSide;
  material.transparent = false;
  material.depthWrite = true;
  material.alphaTest = billboardConfig.alphaTest;
  material.alphaToCoverage = Boolean(config.cinematic?.enabled);
  material.fog = true;
  material.opacityNode = attribute(opacityAttributeName, 'float');
  if (config.cinematic?.enabled && config.cinematic.style?.enabled && material.map) {
    const leafSample = texture(material.map, uv());
    const tint = attribute(tintAttributeName, 'vec3');
    const preserveSnow = sourceMaterial?.userData?.snowPalette === true;
    const canopy = (preserveSnow ? leafSample.rgb : adventureCanopyColor(leafSample.rgb, config)).mul(tint);
    const fill = preserveSnow ? 0 : THREE.MathUtils.clamp(Number(billboardConfig.fill) || 0, 0, 1);
    const lifted = mix(canopy, color(billboardConfig.fillColor ?? '#737363'), fill);
    material.colorNode = vec4(lifted, leafSample.a);
  }
  return material;
}

function smoothStep01(value) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export class TreeSystem {
  constructor({
    scene, camera, terrainRoot, terrainSampler = null, zoneIndex, config, worldData = null, fallbackFactory,
  }) {
    this.scene = scene;
    this.camera = camera;
    this.root = terrainRoot;
    this.terrainSampler = typeof terrainSampler?.sampleHeight === 'function' ? terrainSampler : null;
    this.rootSettings = resolveRootSettings(config.trees.roots);
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
    this.barkMaterials = new Map();
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
    this.resetLod();

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
        rootReach: this.rootSettings.enabled && this.terrainSampler
          ? measureRootReach(high, { rootHeight: this.rootSettings.rootHeight, excludeName: highLeavesName })
          : 0,
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
        lean: Number(record[6]) || 0,
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

  // `lean` tilts the trunk from vertical, toward the tree's own facing.
  #createTree({ index, typeIndex, source, position, rotation, scale, zone, lean = 0 }) {
    const appearance = resolveTreeAppearance(index, position, this.config);
    if (!appearance.retained) return;
    const resolvedScale = scale * appearance.scale;
    const shape = resolveTreeShape(index, position, this.config.trees.shapeVariation);
    const renderAppearance = { tint: appearance.tint, opacity: 1 };
    const roots = { bend: new THREE.Vector2() };
    const high = clone(source.high);
    high.name = `TreeHigh_${index}`;
    high.visible = true;
    high.position.copy(position);
    high.rotation.set(lean, rotation, 0, 'YXZ');
    high.scale.copy(shape).multiplyScalar(resolvedScale);
    this.#seatRoots(high, source, roots);
    prepareTreeClone(
      high, source, this.leafMaterialFactory, renderAppearance, roots, this.barkMaterials, this.rootSettings,
    );
    this.scene.add(high);

    this.trees.push({
      index,
      typeIndex,
      zone,
      high,
      position: high.position,
      rotation,
      lean,
      scale: resolvedScale,
      shape,
      tint: appearance.tint,
      appearance: renderAppearance,
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

  // Bends the root flare onto the ground under it and sinks the tree past any
  // dip the bend misses, so no root hangs in the air on a slope.
  #seatRoots(high, source, roots) {
    if (!this.terrainSampler || !(source.rootReach > 0)) return;
    const { x, z } = high.position;
    const reach = source.rootReach * Math.max(Math.abs(high.scale.x), Math.abs(high.scale.z));
    const sampleHeight = (px, pz) => this.terrainSampler.sampleHeight(px, pz);
    const ground = fitRootGround(sampleHeight, x, z, reach, this.rootSettings);
    high.position.y += ground.sink;
    rootBendFor(high, ground.slopeX, ground.slopeZ, roots.bend);
  }

  #buildBillboards() {
    const counts = new Array(this.sources.length).fill(0);
    for (const tree of this.trees) counts[tree.typeIndex] += 1;

    this.sources.forEach((source, typeIndex) => {
      const count = counts[typeIndex];
      if (!source || count === 0) return;

      const geometry = source.billboardGeometry;
      const opacityAttributeName = `treeOpacity_${typeIndex}`;
      const tintAttributeName = `treeTint_${typeIndex}`;
      const opacity = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
      const tint = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
      opacity.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(opacityAttributeName, opacity);
      geometry.setAttribute(tintAttributeName, tint);

      const material = createBillboardMaterial(
        source.billboardSourceMaterial,
        opacityAttributeName,
        tintAttributeName,
        this.config,
      );
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
        transform.rotation.set(tree.lean, tree.rotation, 0, 'YXZ');
        transform.scale.copy(tree.shape).multiplyScalar(tree.scale);
        transform.updateMatrix();
        group.setMatrixAt(billboardIndex, transform.matrix);
        tint.setXYZ(billboardIndex, tree.tint.r, tree.tint.g, tree.tint.b);
        tree.billboardGroup = group;
        tree.billboardIndex = billboardIndex;
        billboardIndex += 1;
      }
      group.instanceMatrix.needsUpdate = true;
      tint.needsUpdate = true;
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
    tree.transitionHighStart = tree.appearance.opacity;
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
    tree.appearance.opacity = highOpacity;
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

  // Select the opening view before shader warm-up or any reflection capture.
  // Starting every tree at high detail compiles and draws the entire forest.
  resetLod() {
    this.camera.getWorldPosition(this.cameraPosition);
    this.transitioningTrees.clear();
    this.lodUpdateTimer = 0;
    for (const tree of this.trees) {
      const distance = this.#horizontalDistance(tree.position);
      const lod = distance < this.config.trees.highDistance ? LOD_HIGH
        : distance < this.config.trees.billboardDistance ? LOD_BILLBOARD : LOD_HIDDEN;
      tree.currentLOD = tree.targetLOD = lod;
      tree.transitioning = false;
      tree.transitionTime = 0;
      tree.appearance.opacity = lod === LOD_HIGH ? 1 : 0;
      tree.high.visible = lod === LOD_HIGH;
      this.#setBillboardOpacity(tree, lod === LOD_BILLBOARD ? 1 : 0);
    }
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
    }
    for (const material of this.barkMaterials.values()) material.dispose();
    this.barkMaterials.clear();
    this.leafMaterialFactory.dispose();
    this.transitioningTrees.clear();
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
