import * as THREE from 'three/webgpu';
import {
  attribute, color, dot, materialColor, mix, positionGeometry, positionLocal, reference, smoothstep, texture, uv, vertexColor, vec3, vec4,
} from 'three/tsl';
import { adventureCanopyColor } from '../rendering/AdventurePalette.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { createRandom } from '../utils/random.js';
import { logger } from '../utils/logger.js';
import { TreeLeafMaterialFactory } from './TreeLeafMaterial.js';
import { fitRootGround, measureRootReach, resolveRootSettings, rootBendFor } from './treeRootFit.js';
import { loadVegetationLodAssets, primitiveParts } from '../foliage/VegetationLodAssets.js';
import { VegetationLodRenderer } from '../foliage/VegetationLodRenderer.js';
import { VegetationJob } from '../foliage/vegetationRebuild.js';
import { treeLodCenters, treeLodScreenHeights } from '../foliage/vegetationLodPolicy.js';
import { resolveTerrainStreamGroups, streamedTreeTypeIndices } from './terrainStreaming.js';
import { adoptInstanceMatrices } from '../rendering/instanceMatrices.js';
import { tintSeed, weatherBark } from './barkWeathering.js';

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

// `bark` is { config, terrain } for weatherBark, or null to leave it bare.
function cloneHighMaterial(material, rootSettings, bark = null) {
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
  if (bark) {
    weatherBark(cloneMaterial, bark.config, {
      seed: tintSeed(reference('userData.treeAppearance.tint', 'color')),
      terrain: bark.terrain,
    });
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

function prepareTreeClone(root, source, leafMaterialFactory, appearance, roots, barkMaterials, rootSettings, bark = null) {
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
      if (!barkMaterials.has(material)) barkMaterials.set(material, cloneHighMaterial(material, rootSettings, bark));
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
  material.vertexColors = Boolean(sourceMaterial?.vertexColors);
  material.side = THREE.DoubleSide;
  material.transparent = false;
  material.depthWrite = true;
  material.alphaTest = billboardConfig.alphaTest;
  material.alphaToCoverage = Boolean(config.cinematic?.enabled);
  material.fog = true;
  material.opacityNode = attribute(opacityAttributeName, 'float');
  const tint = attribute(tintAttributeName, 'vec3');
  // vertexColor() is a vec4; the billboard's alpha comes from the atlas, so
  // only the colour is a tint here (see TreeLeafMaterial for the same join).
  const vertexTint = sourceMaterial?.vertexColors ? vertexColor().rgb : vec3(1, 1, 1);
  // materialColor folds the material's own map into the colour when one is
  // assigned, so the branches that sample the atlas themselves need the plain
  // colour factor; using materialColor there applies the atlas twice.
  const baseTint = vec3(material.color.r, material.color.g, material.color.b);
  if (material.map) {
    const leafSample = texture(material.map, uv());
    material.colorNode = vec4(leafSample.rgb.mul(baseTint).mul(vertexTint).mul(tint), leafSample.a);
  } else {
    material.colorNode = materialColor.mul(vertexTint).mul(tint);
  }
  if (config.cinematic?.enabled && material.map) {
    const leafSample = texture(material.map, uv());
    const sourceColor = leafSample.rgb.mul(baseTint).mul(vertexTint);
    const preserveSnow = sourceMaterial?.userData?.snowPalette === true;
    const canopy = (preserveSnow ? sourceColor : adventureCanopyColor(sourceColor, config)).mul(tint);
    const fill = !preserveSnow && config.cinematic.style?.enabled
      ? THREE.MathUtils.clamp(Number(billboardConfig.fill) || 0, 0, 1)
      : 0;
    const lifted = fill > 0 ? mix(canopy, color(billboardConfig.fillColor ?? '#737363'), fill) : canopy;
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
    scene, camera, renderer = null, shadowCamera = null, terrainRoot, terrainSampler = null, zoneIndex, config, worldData = null, fallbackFactory,
    assets = null,
  }) {
    this.scene = scene;
    this.assets = assets;
    this.camera = camera;
    this.renderer = renderer;
    this.shadowCamera = shadowCamera;
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
    this.viewportSize = new THREE.Vector2();
    this.lodUpdateTimer = 0;
    this.leafMaterialFactory = new TreeLeafMaterialFactory(config);
    this.barkMaterials = new Map();
    this.qualityName = config.ui.initialQuality;
    this.renderEnabled = true;
    this.createdWorldIndices = new Set();
    this.lodAssetSets = [];
    this.lodFullParts = [];
    this.ecologyTrees = null;
    this.scheduler = null;
    this.schedulerOptions = {};
    this.streamJobs = new Set();
    this.streamJobSequence = 0;
    this.deferredTypeIndices = new Set(
      resolveTerrainStreamGroups(config).flatMap((group) => streamedTreeTypeIndices(group)),
    );
  }

  #createLodRenderer() {
    if (this.lodRenderer) return;
    const settings = this.config.trees.lod;
    this.lodRenderer = new VegetationLodRenderer({
      scene: this.scene,
      config: this.config,
      chunkSize: settings.chunkSize,
      shadowCamera: this.shadowCamera,
      windUniforms: {
        speed: this.leafMaterialFactory.windSpeed,
        strength: this.leafMaterialFactory.windStrength,
        frequency: this.leafMaterialFactory.windFrequency,
        simulationSpeed: this.leafMaterialFactory.simulationSpeed,
      },
      viewportHeight: () => this.renderer?.getSize?.(this.viewportSize)?.y
        ?? settings.screenSpace?.fallbackViewportHeight
        ?? 1080,
      policy: (record, kind, quality) => {
        if (record.quality !== quality) {
          record.quality = quality;
          record.policy = {
            centers: treeLodCenters(record.height, quality, settings),
            screenHeights: treeLodScreenHeights(quality, settings),
            blend: settings.blend,
            far: this.config.trees.billboardDistance,
          };
        }
        return record.policy;
      },
      prepareMaterial: (source, { name }) => {
        const foliage = this.sources.some((treeSource) => treeSource?.highLeavesName === name);
        const material = foliage
          ? this.leafMaterialFactory.create(source, attribute('lodTint', 'vec3'))
          : new THREE.MeshStandardNodeMaterial().copy(source);
        if (!foliage) {
          material.colorNode = materialColor.mul(attribute('lodTint', 'vec3'));
          const bark = this.#barkDetail();
          weatherBark(material, this.config, { seed: tintSeed(attribute('lodTint', 'vec3')), terrain: bark.terrain });
          const base = positionGeometry;
          const bend = attribute('lodRootBend', 'vec2');
          material.positionNode = positionLocal.add(attribute('lodUp', 'vec3').mul(
            dot(bend, base.xz).mul(smoothstep(0, this.rootSettings.conformHeight, base.y).oneMinus()),
          ));
        }
        return material;
      },
    });
    this.lodRenderer.setScheduler(this.scheduler, this.schedulerOptions);
    this.lodRenderer.setRenderEnabled(this.renderEnabled);
  }

  // Settings for weatherBark: the terrain heightfield, once it exists.
  #barkDetail() {
    const terrain = this.terrainSampler?.getShaderData?.() ?? null;
    return { config: this.config, terrain: terrain?.texture ? terrain : null };
  }

  async #loadLodAssets(typeIndices, signal) {
    const keys = [...new Set(typeIndices)].map((typeIndex) => `tree${typeIndex + 1}`);
    const assets = await loadVegetationLodAssets(keys, this.config, signal, { renderer: this.renderer, assets: this.assets });
    try {
      signal?.throwIfAborted();
      // A partial derivative (missing atlas, capture or medium mesh) would render as an
      // untextured impostor, so drop it. addVariant instances the full mesh when a variant
      // carries no asset, which keeps these trees out of scene traversal; aborting instead
      // would send every tree of every type back to per-object rendering.
      const incomplete = keys.filter((key) => {
        const variant = assets.variants.get(key);
        return variant && (!variant.atlas || !variant.entry?.capture || !variant.levels[1]?.length);
      });
      for (const key of incomplete) assets.variants.delete(key);
      if (incomplete.length > 0) {
        logger.warn(`Incomplete tree LOD assets; instancing full meshes: ${incomplete.join(', ')}`);
      }
      return assets;
    } catch (error) {
      assets.dispose();
      throw error;
    }
  }

  #retireLegacyTrees(entries, groups) {
    for (const { tree, obstacle } of entries) {
      tree.high?.removeFromParent();
      tree.high = null;
      tree.highMaterials.length = 0;
      tree.appearance = null;
      tree.obstacle = obstacle;
      tree.billboardGroup = null;
      tree.billboardIndex = -1;
      tree.billboardOpacity = 0;
      tree.transitioning = false;
      this.transitioningTrees.delete(tree);
    }

    const retired = new Set(groups);
    for (const group of retired) {
      group.removeFromParent();
      group.material?.dispose?.();
      const source = this.sources.find(candidate => candidate?.billboardGroup === group);
      if (source) {
        source.billboardGroup = null;
        source.billboardGeometry?.dispose?.();
        source.billboardGeometry = null;
      } else {
        group.geometry?.dispose?.();
      }
    }
    this.billboardGroups = this.billboardGroups.filter(group => !retired.has(group));
  }

  #rollbackStreamedTypes(addedSources, createdTrees, createdGroups, processedWorldIndices) {
    const trees = new Set(createdTrees);
    for (let index = this.trees.length - 1; index >= 0; index -= 1) {
      const tree = this.trees[index];
      if (!trees.has(tree)) continue;
      tree.high?.removeFromParent();
      this.transitioningTrees.delete(tree);
      this.trees.splice(index, 1);
    }

    const groups = new Set(createdGroups);
    for (let index = this.billboardGroups.length - 1; index >= 0; index -= 1) {
      const group = this.billboardGroups[index];
      if (!groups.has(group)) continue;
      group.removeFromParent();
      group.material?.dispose?.();
      this.billboardGroups.splice(index, 1);
    }

    for (const [typeIndex, source] of addedSources) {
      if (this.sources[typeIndex] !== source) continue;
      source.billboardGroup = null;
      source.billboardGeometry?.dispose?.();
      source.billboardGeometry = null;
      this.sources[typeIndex] = null;
    }

    for (const index of processedWorldIndices) this.createdWorldIndices.delete(index);
  }

  async #addLodTypes(typeIndices, signal, preparedAssets = null, { stage = false } = {}) {
    const indices = [...new Set(typeIndices)]
      .filter((typeIndex) => this.sources[typeIndex]
        && this.trees.some((tree) => tree.typeIndex === typeIndex));
    if (indices.length === 0) {
      preparedAssets?.dispose();
      return;
    }

    const assets = preparedAssets ?? await this.#loadLodAssets(indices, signal);
    if (signal?.aborted || this.disposed) {
      assets.dispose();
      signal?.throwIfAborted();
      return;
    }

    this.#createLodRenderer();
    const state = {
      stages: [],
      fullParts: [],
      legacyTrees: [],
      legacyGroups: [],
      committed: false,
    };
    const cleanup = () => {
      if (state.committed) return;
      for (const variantStage of state.stages) this.lodRenderer?.disposeVariantStage(variantStage);
      for (const part of state.fullParts) part.geometry.dispose();
      state.stages.length = 0;
      state.fullParts.length = 0;
      assets.dispose();
    };
    const finish = () => {
      for (const variantStage of state.stages) this.lodRenderer.commitVariantStage(variantStage);
      this.lodAssetSets.push(assets);
      this.lodFullParts.push(...state.fullParts);
      state.committed = true;
      state.stages.length = 0;
      state.fullParts.length = 0;
      this.setQuality(this.qualityName);
      this.lodRenderer.setRenderEnabled(this.renderEnabled);
      this.lodRenderer.update(this.camera, true);
      this.#retireLegacyTrees(state.legacyTrees, state.legacyGroups);
      this.stats = this.lodRenderer.stats;
    };

    if (stage && this.scheduler) {
      const scheduler = this.scheduler;
      const id = `lod:${this.scene.uuid}:${++this.streamJobSequence}:${indices.join(',')}`;
      await new Promise((resolve, reject) => {
        const cancel = () => scheduler.cancel(id);
        this.streamJobs.add(id);
        scheduler.replace(id, new VegetationJob({
          class: 'stream',
          owner: 'trees',
          generate: () => this.#registerLodTypes(indices, assets, state, signal),
          publish: () => {
            signal?.throwIfAborted();
            if (this.disposed) throw new DOMException('Tree system disposed', 'AbortError');
            finish();
          },
          onSettled: (job) => {
            signal?.removeEventListener('abort', cancel);
            this.streamJobs.delete(id);
            if (job.published) resolve();
            else {
              cleanup();
              reject(job.error ?? signal?.reason ?? new DOMException('Tree registration cancelled', 'AbortError'));
            }
          },
        }));
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted || this.disposed) cancel();
      });
      return;
    }

    try {
      for (const _step of this.#registerLodTypes(indices, assets, state, signal)) continue;
      finish();
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  *#registerLodTypes(indices, assets, state, signal) {
    for (const typeIndex of indices) {
      signal?.throwIfAborted();
      if (this.disposed) throw new DOMException('Tree system disposed', 'AbortError');
      const source = this.sources[typeIndex];
      const full = primitiveParts(source.high);
      const bounds = new THREE.Box3();
      for (const part of full) bounds.union(part.geometry.boundingBox);
      const sphere = bounds.getBoundingSphere(new THREE.Sphere());
      const obstacleBounds = new THREE.Box3();
      const records = [];
      let processed = 0;

      for (const tree of this.trees) {
        if (tree.typeIndex !== typeIndex || !tree.high) continue;
        tree.high.updateMatrixWorld(true);
        const worldSphere = sphere.clone().applyMatrix4(tree.high.matrixWorld);
        obstacleBounds.setFromObject(tree.high);
        state.legacyTrees.push({
          tree,
          obstacle: {
            x: (obstacleBounds.min.x + obstacleBounds.max.x) * 0.5,
            z: (obstacleBounds.min.z + obstacleBounds.max.z) * 0.5,
            radius: Math.max(
              obstacleBounds.max.x - obstacleBounds.min.x,
              obstacleBounds.max.z - obstacleBounds.min.z,
            ) * 0.5,
            top: obstacleBounds.max.y,
          },
        });
        records.push({
          position: tree.position,
          matrix: new Float32Array(tree.high.matrixWorld.elements),
          height: (bounds.max.y - bounds.min.y) * tree.high.scale.y,
          tint: tree.tint,
          bend: tree.high.children[0]?.userData.treeRoots?.bend,
          fraction: 0,
          sphere: worldSphere,
        });
        processed += 1;
        if (processed % 128 === 0) yield;
      }

      const variantStage = this.lodRenderer.createVariantStage({
        key: `tree${typeIndex + 1}`,
        full,
        asset: assets.variants.get(`tree${typeIndex + 1}`),
        records,
      });
      if (variantStage) {
        for (const _step of variantStage.iterator) yield;
        state.stages.push(variantStage);
      }
      state.fullParts.push(...full);
      if (source.billboardGroup) state.legacyGroups.push(source.billboardGroup);
      yield typeIndex;
    }
  }

  async initLods(signal) {
    if (!this.config.vegetationLod?.enabled || !this.trees.length) return;
    try {
      this.#createLodRenderer();
      const typeIndices = this.sources
        .map((source, typeIndex) => (source ? typeIndex : null))
        .filter((typeIndex) => typeIndex !== null);
      await this.#addLodTypes(typeIndices, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      this.lodRenderer?.dispose();
      this.lodRenderer = null;
      for (const assets of this.lodAssetSets.splice(0)) assets.dispose();
      for (const part of this.lodFullParts.splice(0)) part.geometry.dispose();
      for (const tree of this.trees) {
        if (!tree.high.parent) this.scene.add(tree.high);
      }
      for (const group of this.billboardGroups) {
        if (!group.parent) this.scene.add(group);
        group.visible = true;
      }
      this.resetLod();
      logger.warn('Tree LOD assets unavailable; retaining original tree rendering.', error);
    }
  }

  async addStreamedTypes(typeIndices, signal) {
    const requested = [...new Set(typeIndices)].filter((typeIndex) => !this.sources[typeIndex]);
    if (requested.length === 0 || this.disposed) return [];

    const lodAssets = this.config.vegetationLod?.enabled
      ? await this.#loadLodAssets(requested, signal)
      : null;
    if (signal?.aborted || this.disposed) {
      lodAssets?.dispose();
      signal?.throwIfAborted();
      return [];
    }

    const hadLodRenderer = Boolean(this.lodRenderer);
    const treeStart = this.trees.length;
    const billboardStart = this.billboardGroups.length;
    const addedTypes = [];
    const addedSources = [];
    let processedWorldIndices = [];
    let createdTrees = [];
    let createdGroups = [];

    try {
      for (const typeIndex of requested) {
        if (this.sources[typeIndex]) continue;
        const source = this.#setupSource(typeIndex);
        if (!source) continue;
        addedTypes.push(typeIndex);
        addedSources.push([typeIndex, source]);
      }
      if (addedTypes.length === 0) {
        lodAssets?.dispose();
        return [];
      }

      if (this.worldData?.length) {
        processedWorldIndices = this.#createTreesFromWorldData(new Set(addedTypes));
      }
      this.#buildBillboards(new Set(addedTypes));
      createdTrees = this.trees.slice(treeStart);
      createdGroups = this.billboardGroups.slice(billboardStart);
      this.#hideSourceObjects(new Set(addedTypes));

      if (lodAssets && createdTrees.length > 0) {
        await this.#addLodTypes(addedTypes, signal, lodAssets, { stage: true });
      } else {
        lodAssets?.dispose();
        this.resetLod();
      }
    } catch (error) {
      this.#rollbackStreamedTypes(addedSources, createdTrees, createdGroups, processedWorldIndices);
      if (!hadLodRenderer && this.lodRenderer) {
        this.lodRenderer.dispose();
        this.lodRenderer = null;
      }
      lodAssets?.dispose();
      throw error;
    }

    logger.info('Streamed tree types initialized.', {
      types: addedTypes.map((typeIndex) => typeIndex + 1),
      trees: createdTrees.length,
    });
    return createdTrees;
  }

  getEcologyTrees() {
    if (!this.worldData?.length) return this.trees;
    if (this.ecologyTrees) return this.ecologyTrees;

    this.ecologyTrees = [];
    this.worldData.forEach((record, index) => {
      if (!Array.isArray(record) || record.length < 6) return;
      const typeIndex = Number(record[5]);
      if (!this.config.trees.types?.[typeIndex]) return;
      const position = new THREE.Vector3(Number(record[0]), Number(record[1]), Number(record[2]));
      if (![position.x, position.y, position.z].every(Number.isFinite)) return;
      const appearance = resolveTreeAppearance(index, position, this.config);
      if (!appearance.retained) return;
      this.ecologyTrees.push({
        index,
        typeIndex,
        position,
        scale: Number(record[4]) * appearance.scale,
      });
    });
    return this.ecologyTrees;
  }

  setRenderEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.renderEnabled === next) return;
    this.renderEnabled = next;
    if (this.lodRenderer) {
      this.lodRenderer.setRenderEnabled(next);
      if (next) this.lodRenderer.update(this.camera, true);
      return;
    }
    if (!next) {
      for (const tree of this.trees) if (tree.high) tree.high.visible = false;
      for (const group of this.billboardGroups) group.visible = false;
      return;
    }
    this.resetLod();
  }

  setQuality(name) { this.qualityName = name; this.lodRenderer?.setQuality(name); }

  setScheduler(scheduler, options = {}) {
    if (this.scheduler && this.scheduler !== scheduler) {
      for (const id of this.streamJobs) this.scheduler.cancel(id);
    }
    this.scheduler = scheduler ?? null;
    this.schedulerOptions = options;
    this.lodRenderer?.setScheduler(scheduler, options);
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
    this.sources = new Array(this.config.trees.types.length).fill(null);
    for (let typeIndex = 0; typeIndex < this.config.trees.types.length; typeIndex += 1) {
      if (this.deferredTypeIndices.has(typeIndex)) continue;
      this.#setupSource(typeIndex);
    }
  }

  #setupSource(typeIndex) {
    const definition = this.config.trees.types[typeIndex];
    if (!definition) return null;
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

    const source = {
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
    this.sources[typeIndex] = source;
    return source;
  }

  #createTreesFromWorldData(typeIndices = null) {
    const processed = [];
    this.worldData.forEach((record, index) => {
      if (!Array.isArray(record) || record.length < 6 || this.createdWorldIndices.has(index)) return;
      const typeIndex = Number(record[5]);
      if (typeIndices && !typeIndices.has(typeIndex)) return;
      const source = this.sources[typeIndex];
      if (!source) return;
      this.createdWorldIndices.add(index);
      processed.push(index);
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
    return processed;
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
    markerGroup.userData.skipWarmup = true;
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
    high.userData.skipWarmup = false;
    high.name = `TreeHigh_${index}`;
    high.visible = true;
    high.position.copy(position);
    high.rotation.set(lean, rotation, 0, 'YXZ');
    high.scale.copy(shape).multiplyScalar(resolvedScale);
    // No plane seats a root flare on a cliff or ridge edge: its roots would
    // stand in the air, so the tree is left out.
    if (!this.#seatRoots(high, source, roots)) return;
    prepareTreeClone(
      high, source, this.leafMaterialFactory, renderAppearance, roots, this.barkMaterials, this.rootSettings,
      this.#barkDetail(),
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
      worldScale: high.scale.clone(),
      obstacle: null,
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
  // dip the bend misses, so no root hangs in the air on a slope. False when the
  // roots would still overhang the ground by more than maxOverhang.
  #seatRoots(high, source, roots) {
    if (!this.terrainSampler || !(source.rootReach > 0)) return true;
    const { x, z } = high.position;
    const reach = source.rootReach * Math.max(Math.abs(high.scale.x), Math.abs(high.scale.z));
    const sampleHeight = (px, pz) => this.terrainSampler.sampleHeight(px, pz);
    const ground = fitRootGround(sampleHeight, x, z, reach, this.rootSettings);
    if (ground.overhang > this.rootSettings.maxOverhang) return false;
    high.position.y += ground.sink;
    rootBendFor(high, ground.slopeX, ground.slopeZ, roots.bend);
    return true;
  }

  #buildBillboards(typeIndices = null) {
    const counts = new Array(this.sources.length).fill(0);
    for (const tree of this.trees) counts[tree.typeIndex] += 1;

    this.sources.forEach((source, typeIndex) => {
      const count = counts[typeIndex];
      if (typeIndices && !typeIndices.has(typeIndex)) return;
      if (!source || count === 0 || source.billboardGroup) return;

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
      const group = adoptInstanceMatrices(new THREE.InstancedMesh(geometry, material, count));
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

  #hideSourceObjects(typeIndices = null) {
    for (const [typeIndex, source] of this.sources.entries()) {
      if (typeIndices && !typeIndices.has(typeIndex)) continue;
      if (!source) continue;
      source.high.visible = false;
      source.low.visible = false;
      source.high.userData.skipWarmup = true;
      source.low.userData.skipWarmup = true;
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

  setSimulationSpeed(value) {
    this.leafMaterialFactory.setSimulationSpeed(value);
  }

  // Select the opening view before shader warm-up or any reflection capture.
  // Starting every tree at high detail compiles and draws the entire forest.
  resetLod() {
    if (this.lodRenderer) { this.lodRenderer.update(this.camera, true); return; }
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
    if (!this.renderEnabled) return;
    if (this.lodRenderer) { this.lodRenderer.update(this.camera); return; }
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
    this.disposed = true;
    for (const id of this.streamJobs) this.scheduler?.cancel(id);
    this.streamJobs.clear();
    this.lodRenderer?.dispose();
    for (const assets of this.lodAssetSets.splice(0)) assets.dispose();
    for (const part of this.lodFullParts ?? []) part.geometry.dispose(); this.lodFullParts = [];
    for (const tree of this.trees) tree.high?.removeFromParent();
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
    this.createdWorldIndices.clear();
    this.ecologyTrees = null;
  }
}
