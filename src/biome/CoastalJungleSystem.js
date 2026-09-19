import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetUrl } from '../assets/assetUrl.js';
import { captureObjectResources } from '../utils/ResourceScope.js';
import { logger } from '../utils/logger.js';
import {
  coastalJungleHazePresence,
  isCoastalJungleFoliageMaterial,
  prepareCoastalJungleMaterial,
} from './CoastalJungleMaterial.js';
import {
  classifyCoastalJungleObject,
  coastalJungleEdgeKeeps,
  coastalJungleRegionCenter,
  coastalJungleRegionRadius,
  coastalJungleRegionWeight,
  coastalJungleSourceElevation,
  evaluateCoastalJunglePlacement,
  coastalJungleTileKeeps,
  mapCoastalJungleHorizontal,
  resolveCoastalJungleFrames,
} from './CoastalJunglePlacement.js';
import { setCoastalJungleRuntimeActive } from './CoastalJungleRuntime.js';
import { scatterCoastalJungleFloor } from './CoastalJungleScatter.js';
import {
  coastalJungleInstanceKey,
  coastalJungleStableFraction,
} from './CoastalJungleVisibility.js';
import { CoastalJungleCulling } from './CoastalJungleCulling.js';
import { conformCoastalJungleSurface } from './CoastalJungleSurface.js';
import { loadVegetationLodAssets } from '../foliage/VegetationLodAssets.js';
import { VegetationLodRenderer } from '../foliage/VegetationLodRenderer.js';
import { TREE_KINDS, treeLodCenters } from '../foliage/vegetationLodPolicy.js';

const FLOOR_NAME = 'ForestFloor';
const PATH_NAME = 'ForestPath';
// Blender exports each instanced asset as a node named after it.
const ASSET_NODE_SUFFIX = '_instances';
const DEFAULT_QUALITY = 'high';
const DEFAULT_EDGE_FADE = 18;
const WORK_CHECK_INTERVAL = 256;
const WORK_BUDGET_MS = 8;
const INSTANCE_SPHERE_FALLBACK_RADIUS = 1;
const UP = new THREE.Vector3(0, 1, 0);

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function trianglesPerInstance(object) {
  const geometry = object?.geometry;
  if (!geometry?.attributes?.position) return 0;
  return (geometry.index?.count ?? geometry.attributes.position.count) / 3;
}

function clampDensity(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function boxHull(radius, height) {
  const r = Math.max(0.05, radius);
  const h = Math.max(0.1, height) * 0.5;
  return new Float32Array([
    -r, -h, -r, r, -h, -r, r, -h, r, -r, -h, r,
    -r, h, -r, r, h, -r, r, h, r, -r, h, r,
  ]);
}

function assetNodeOf(object) {
  for (const node of [object, object.parent]) {
    if (node?.name?.endsWith(ASSET_NODE_SUFFIX)) return node;
  }
  return null;
}

// One sphere around every part of an asset, in the parts' shared local space.
function partsBoundingSphere(parts) {
  const bounds = new THREE.Box3().makeEmpty();
  for (const part of parts) {
    part.geometry.computeBoundingBox?.();
    if (part.geometry.boundingBox) bounds.union(part.geometry.boundingBox);
  }
  return bounds.isEmpty() ? null : bounds.getBoundingSphere(new THREE.Sphere());
}

export class CoastalJungleSystem {
  constructor({ scene, config, terrain, expansion = null, collisions = null } = {}) {
    this.scene = scene;
    this.config = config;
    this.terrain = terrain;
    this.expansion = expansion;
    this.collisions = collisions;
    this.profile = config?.biomes?.coastalJungle ?? null;
    this.qualityName = config?.ui?.initialQuality ?? DEFAULT_QUALITY;
    this.root = null;
    this.lod = null;
    this.farRoot = null;
    this.releaseGltf = null;
    this.frame = null;
    this.frames = [];
    this.tileSize = 0;
    this.batches = [];
    this.singles = [];
    this.colliderRecords = [];
    this.colliderKinds = new Set(Object.keys(this.profile?.collider ?? {}));
    this.runtimeMaterials = new Set();
    this.materialVariants = new Map();
    this.culling = null;
    this.initTask = null;
    this.ready = false;
    this.disposed = false;
    this.lastYield = 0;
    this.visibilityUpdater = (camera) => this.update(camera);
    this.stats = {
      active: false,
      batches: 0,
      sourceInstances: 0,
      scatterInstances: 0,
      availableInstances: 0,
      visibleInstances: 0,
      visibleChunks: 0,
      totalChunks: 0,
      colliders: 0,
      triangles: 0,
      regionRadius: 0,
      visibilityDistance: 0,
      bookkeepingMs: 0,
      revision: 0,
      byKind: {},
    };
  }

  init(signal) {
    if (this.disposed || !this.profile?.enabled || !this.profile.asset) return this;
    if (!this.config?.water?.sea?.enabled || !this.terrain) return this;
    if (this.initTask) return this;

    this.initTask = this.#initialize(signal).catch((error) => {
      if (error?.name === 'AbortError' || signal?.aborted || this.disposed) return;
      logger.warn('Coastal jungle could not start; continuing without it.', error);
      this.dispose();
    });
    return this;
  }

  async #initialize(signal) {
    const gltf = await new GLTFLoader().loadAsync(assetUrl(this.profile.asset));
    const release = captureObjectResources(gltf.scene);
    if (signal?.aborted || this.disposed) {
      release();
      signal?.throwIfAborted();
      return;
    }

    this.releaseGltf = release;
    this.root = gltf.scene;
    this.root.name = 'CoastalJungle';
    this.root.updateWorldMatrix(true, true);
    this.frames = resolveCoastalJungleFrames(this.profile.region);
    if (this.frames.length === 0) {
      logger.warn('Coastal jungle region has no valid origin; skipping biome.');
      this.dispose();
      return;
    }
    for (const frame of this.frames) frame.rotation = new THREE.Quaternion().setFromAxisAngle(UP, frame.yaw);
    [this.frame] = this.frames;
    // Copies only need clipping to their squares when there is more than one.
    this.tileSize = this.frames.length > 1
      ? Number(this.profile.region.tileSize ?? 2 * Number(this.profile.scatter?.extent ?? 0))
      : 0;
    this.lastYield = now();

    const collected = this.#collectSource();
    const sourceInstances = collected.batches.reduce((sum, batch) => sum + batch.sources.length, 0)
      + collected.singles.filter((single) => single.primary).length;
    if (sourceInstances === 0) {
      logger.warn('Coastal jungle scene contained no recognized vegetation instances.');
      this.dispose();
      return;
    }
    const scatterSources = this.#collectScatter(collected.batches);

    signal?.throwIfAborted();
    await this.#relocateBatches(collected.batches, signal);
    await this.#relocateSingles(collected.singles, signal);
    if (this.disposed) return;
    const availableInstances = this.#availableInstanceCount();
    if (availableInstances === 0) {
      logger.warn('Coastal jungle placement rejected every authored vegetation instance; skipping biome.');
      this.dispose();
      return;
    }

    const surfaceContext = {
      frame: this.frame,
      region: this.profile.region,
      sea: this.config.water.sea,
      terrain: this.terrain,
      paths: this.expansion?.paths,
      placement: this.profile.placement,
      signal,
      isDisposed: () => this.disposed,
    };
    await conformCoastalJungleSurface({
      ...surfaceContext,
      object: collected.floor,
      offset: Number(this.profile.placement?.groundOffset ?? 0.025),
      revealRoutes: true,
    });
    await conformCoastalJungleSurface({
      ...surfaceContext,
      object: collected.path,
      offset: Number(this.profile.placement?.pathOffset ?? 0.045),
      transparent: true,
    });
    if (this.disposed) return;

    this.#prepareRendering();
    this.#mountLod();
    this.root.updateWorldMatrix(true, true);
    this.culling = new CoastalJungleCulling(this.profile, this.batches, this.singles);
    this.stats.totalChunks = this.culling.build();
    await this.#initializeLods(signal);
    if (this.disposed) return;
    this.#registerColliders();

    setCoastalJungleRuntimeActive(this.config, true);
    this.ready = true;
    this.stats.active = true;
    this.stats.sourceInstances = sourceInstances;
    this.stats.scatterInstances = this.batches.reduce((sum, batch) => sum + batch.scatterCount, 0);
    this.stats.availableInstances = availableInstances;
    this.stats.batches = this.batches.length;
    if (this.scene?.userData) this.scene.userData.updateCoastalJungleVisibility = this.visibilityUpdater;
    this.setQuality(this.qualityName);

    logger.info('Coastal jungle biome initialized.', {
      batches: this.stats.batches,
      sourceInstances,
      scatterCandidates: scatterSources,
      scatterInstances: this.stats.scatterInstances,
      availableInstances,
      chunks: this.stats.totalChunks,
      colliders: this.stats.colliders,
      visibilityDistance: this.stats.visibilityDistance,
    });
  }

  setQuality(name) {
    this.qualityName = name ?? DEFAULT_QUALITY;
    this.lodRenderer?.setQuality(this.qualityName);
    this.culling?.markDirty();
    if (!this.ready) return;
    const quality = this.#quality();
    const shadowKinds = new Set(this.profile.shadowKinds ?? []);
    for (const batch of this.batches) {
      for (const part of batch.parts) {
        part.castShadow = Boolean(quality.shadows && shadowKinds.has(batch.kind));
        part.receiveShadow = true;
      }
    }
    for (const single of this.singles) {
      single.object.castShadow = Boolean(single.record && quality.shadows && shadowKinds.has(single.kind));
      single.object.receiveShadow = true;
    }
    this.#applyLodDistance(quality);
  }

  update(camera, force = false) {
    if (!this.ready || this.disposed || !this.culling) return this.stats;
    if (camera?.position) {
      coastalJungleHazePresence.value = coastalJungleRegionWeight(
        camera.position.x,
        camera.position.z,
        this.profile.region,
        this.config.water.sea,
        this.#edgeFade(),
      );
    }
    const result = this.lodRenderer ? this.lodRenderer.update(camera, force) : this.culling.update(camera, this.#quality(), force);
    if (result) Object.assign(this.stats, result);
    return this.stats;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lodRenderer?.dispose(); this.lodAssets?.dispose();
    setCoastalJungleRuntimeActive(this.config, false);
    this.collisions?.removeGroup(this.profile?.collisionGroup ?? 'coastalJungle');
    if (this.scene?.userData?.updateCoastalJungleVisibility === this.visibilityUpdater) {
      delete this.scene.userData.updateCoastalJungleVisibility;
    }
    this.lod?.removeFromParent();
    for (const material of this.runtimeMaterials) material.dispose?.();
    this.runtimeMaterials.clear();
    this.materialVariants.clear();
    this.releaseGltf?.();
    this.releaseGltf = null;
    this.root = null;
    this.lod = null;
    this.farRoot = null;
    this.batches.length = 0;
    this.singles.length = 0;
    this.culling = null;
    this.colliderRecords.length = 0;
    this.ready = false;
    this.stats.active = false;
  }

  #quality() {
    return this.profile.quality?.[this.qualityName]
      ?? this.profile.quality?.[DEFAULT_QUALITY]
      ?? {};
  }

  #availableInstanceCount() {
    return this.batches.reduce((sum, batch) => sum + batch.records.length, 0)
      + this.singles.filter((single) => single.record && single.primary).length;
  }

  // Long placement work yields to the page every few milliseconds rather than
  // every few records, which would spend most of the time waiting on timers.
  #yieldDue(processed) {
    return processed % WORK_CHECK_INTERVAL === 0 && now() - this.lastYield >= WORK_BUDGET_MS;
  }

  async #yield(signal) {
    await nextTask();
    this.lastYield = now();
    signal?.throwIfAborted();
  }

  #mountLod() {
    const center = coastalJungleRegionCenter(this.profile.region, this.config.water.sea);
    if (!center) throw new Error('Coastal jungle region has no valid center.');
    const sampledHeight = this.terrain.sampleHeight(center.x, center.z);
    const centerY = Number.isFinite(sampledHeight) ? sampledHeight : 0;
    const regionRadius = coastalJungleRegionRadius(this.profile.region, this.config.water.sea);
    const hysteresis = clampDensity(this.profile.render?.lodHysteresis ?? 0.06);

    const lod = new THREE.LOD();
    lod.name = 'CoastalJungleLOD';
    lod.position.set(center.x, centerY, center.z);
    this.root.position.x -= center.x;
    this.root.position.y -= centerY;
    this.root.position.z -= center.z;
    this.root.updateMatrix();

    const farRoot = new THREE.Group();
    farRoot.name = 'CoastalJungleCulled';
    lod.addLevel(this.root, 0, hysteresis);
    lod.addLevel(farRoot, this.#visibilityDistance(this.#quality(), regionRadius), hysteresis);
    this.scene?.add(lod);

    this.lod = lod;
    this.farRoot = farRoot;
    this.stats.regionRadius = regionRadius;
  }

  #visibilityDistance(quality, radius = this.stats.regionRadius) {
    if (this.lodRenderer) return this.profile.lod.treeDistances[this.qualityName] + Math.max(0, radius);
    return Math.max(1, Number(quality?.maxDistance ?? 180)) + Math.max(0, radius);
  }

  async #initializeLods(signal) {
    if (!this.config.vegetationLod?.enabled || !this.profile.lod?.enabled) return;
    const variants = this.batches.map(batch => ({ key: `jungle-${batch.asset}`, kind: batch.kind,
      parts: batch.parts, records: batch.records, matrix: batch.parts[0].matrixWorld }));
    const singleGroups = new Map();
    for (const single of this.singles) {
      if (!single.record) continue;
      let node = single.object;
      while (node.parent && node.parent !== this.root) node = node.parent;
      let group = singleGroups.get(node);
      if (!group) {
        group = { key: `jungle-${node.name}`, kind: single.kind, parts: [], matrix: new THREE.Matrix4(),
          records: [{ ...single.record, matrix: new Float32Array(single.object.matrixWorld.elements) }] };
        singleGroups.set(node, group);
      }
      group.parts.push(single.object);
    }
    variants.push(...singleGroups.values());
    try {
      const assets = await loadVegetationLodAssets(variants.map(v => v.key), this.config, signal);
      if (signal?.aborted || this.disposed) { assets.dispose(); signal?.throwIfAborted(); return; }
      this.lodAssets = assets;
      const render = this.profile.render, lod = this.profile.lod;
      const renderer = new VegetationLodRenderer({ scene: this.scene, config: this.config, chunkSize: lod.chunkSize,
        prepareMaterial: (source, { kind }) => {
          const material = new MeshStandardNodeMaterial().copy(source);
          prepareCoastalJungleMaterial(material, { kind, instanced: true, settings: this.profile.material,
            anisotropy: this.profile.anisotropy, cinematic: Boolean(this.config.cinematic?.enabled) });
          return material;
        },
        policy: (record, kind, quality) => {
          if (record.quality !== quality) {
            record.quality = quality;
            const tree = TREE_KINDS.has(kind);
            const end = kind === 'grass' ? render.grassDistance : kind === 'groundcover' ? render.groundcoverDistance : render.undergrowthDistance;
            const start = kind === 'grass' ? render.grassDenseDistance : end * 0.75;
            record.policy = { centers: tree ? treeLodCenters(record.height, quality, this.config.trees.lod) : [(start + end) / 2],
              blend: tree ? this.config.trees.lod.blend : (end - start) / (end + start), plant: !tree,
              far: tree ? lod.treeDistances[quality] : lod.plantDistances[quality],
              density: this.profile.quality[quality].density[kind] ?? 1 };
          }
          return record.policy;
        },
      });
      this.lodRenderer = renderer;
      for (const variant of variants) {
        const full = variant.parts.map(part => ({ geometry: part.geometry, material: part.material, name: part.name }));
        const bounds = new THREE.Box3();
        for (const part of full) { part.geometry.computeBoundingBox(); bounds.union(part.geometry.boundingBox); }
        const matrix = new THREE.Matrix4(), scale = new THREE.Vector3();
        const records = variant.records.map(record => {
          matrix.multiplyMatrices(variant.matrix, new THREE.Matrix4().fromArray(record.matrix));
          scale.setFromMatrixScale(matrix);
          return { position: record.position.clone(), matrix: new Float32Array(matrix.elements), sphere: record.sphere,
            fraction: record.stableFraction, height: (bounds.max.y - bounds.min.y) * scale.y };
        });
        renderer.addVariant({ ...variant, full, records, asset: assets.variants.get(variant.key),
          excludeFromReflection: true, castShadow: (this.profile.shadowKinds ?? []).includes(variant.kind) });
      }
      for (const variant of variants) for (const part of variant.parts) part.visible = false;
      renderer.setQuality(this.qualityName);
    } catch (error) {
      this.lodRenderer?.dispose(); this.lodRenderer = null; this.lodAssets?.dispose();
      if (signal?.aborted) throw error;
      logger.warn('Jungle LOD assets unavailable; retaining original rendering.', error);
    }
  }

  #applyLodDistance(quality) {
    if (!this.lod || !this.farRoot) return;
    const level = this.lod.levels.find((entry) => entry.object === this.farRoot);
    const distance = this.#visibilityDistance(quality);
    if (level) level.distance = distance;
    this.lod.levels.sort((a, b) => a.distance - b.distance);
    this.stats.visibilityDistance = distance;
  }

  // Instanced parts of one asset (bark, leaves) carry the same instances, so
  // they become one batch that shares a single instance buffer.
  #collectSource() {
    const groups = [];
    const singles = [];
    const singleKeys = new Set();
    const singlePosition = new THREE.Vector3();
    let floor = null;
    let path = null;

    this.root.traverse((object) => {
      if (object.name === FLOOR_NAME) floor = object;
      if (object.name === PATH_NAME) path = object;
      if (!object.isMesh || object.name === FLOOR_NAME || object.name === PATH_NAME) return;
      const kind = classifyCoastalJungleObject(object);
      if (!kind) return;
      object.updateWorldMatrix(true, false);
      if (!object.isInstancedMesh) {
        // The parts of one authored plant share its transform; count it once.
        const key = coastalJungleInstanceKey(singlePosition.setFromMatrixPosition(object.matrixWorld), kind);
        singles.push({ object, kind, primary: !singleKeys.has(key) });
        singleKeys.add(key);
        return;
      }
      const node = assetNodeOf(object) ?? object;
      const group = groups.find((candidate) => candidate.node === node
        && candidate.parts[0].count === object.count
        && candidate.parts[0].matrixWorld.equals(object.matrixWorld));
      if (group) {
        group.parts.push(object);
        return;
      }
      groups.push({
        node,
        asset: node.name.endsWith(ASSET_NODE_SUFFIX) ? node.name.slice(0, -ASSET_NODE_SUFFIX.length) : null,
        kind,
        parts: [object],
      });
    });

    const instanceMatrix = new THREE.Matrix4();
    const worldMatrix = new THREE.Matrix4();
    const batches = groups.map(({ asset, kind, parts }) => {
      const [first] = parts;
      const sources = [];
      for (let index = 0; index < first.count; index += 1) {
        first.getMatrixAt(index, instanceMatrix);
        worldMatrix.multiplyMatrices(first.matrixWorld, instanceMatrix);
        const position = new THREE.Vector3();
        const rotation = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        worldMatrix.decompose(position, rotation, scale);
        sources.push({ position, rotation, scale });
      }
      return { asset, kind, parts, sources, scatter: [] };
    });
    return { batches, singles, floor, path };
  }

  // Replays the original's load-time floor scatter; only plants landing in
  // the strip are kept for placement.
  #collectScatter(batches) {
    const settings = this.profile.scatter;
    if (!settings) return 0;
    const byAsset = new Map(batches.filter((batch) => batch.asset).map((batch) => [batch.asset, batch]));
    const region = this.profile.region;
    const sea = this.config.water.sea;
    const edgeFade = this.#edgeFade();
    let candidates = 0;
    scatterCoastalJungleFloor(settings, [...byAsset.keys()], (asset, x, z, yaw, scale) => {
      if (!coastalJungleTileKeeps({ x, z }, this.tileSize)) return;
      for (const frame of this.frames) {
        const mapped = mapCoastalJungleHorizontal({ x, z }, frame);
        if (!(coastalJungleRegionWeight(mapped.x, mapped.z, region, sea, edgeFade) > 0)) continue;
        byAsset.get(asset).scatter.push({ x, z, yaw, scale, frame });
        candidates += 1;
      }
    });
    return candidates;
  }

  #edgeFade() {
    return Math.max(0, Number(this.profile.ecology?.edgeFade ?? DEFAULT_EDGE_FADE));
  }

  // Outside its hero patch the original stands big backdrop shrubs (its
  // distant understory) close enough to cover the ground about twice over:
  // depth for a view that only sees them from the patch, but a wall around a
  // camera walking among them. Only that layer is thinned.
  #keepsAuthored(kind, position) {
    if (kind !== 'shrub') return true;
    const heroExtent = Number(this.profile.scatter?.plantExtent ?? 0);
    if (Math.abs(position.x) < heroExtent && Math.abs(position.z) < heroExtent) return true;
    const density = clampDensity(this.profile.ecology?.backdropShrubDensity ?? 1);
    return coastalJungleStableFraction(position, 'backdrop') < density;
  }

  // Maps one authored transform onto the live terrain, or null when the strip
  // crops it, its edge band thins it out or the ground rejects it.
  #target(kind, position, rotation, scale, frame = this.frame) {
    if (!coastalJungleTileKeeps(position, this.tileSize)) return null;
    const mapped = mapCoastalJungleHorizontal(position, frame);
    if (!mapped) return null;
    const weight = coastalJungleRegionWeight(
      mapped.x,
      mapped.z,
      this.profile.region,
      this.config.water.sea,
      this.#edgeFade(),
    );
    if (!(weight > 0)) return null;
    const edgeFraction = coastalJungleStableFraction({ x: mapped.x, y: 0, z: mapped.z }, `${kind}:edge`);
    if (!coastalJungleEdgeKeeps(weight, edgeFraction)) return null;
    const placement = evaluateCoastalJunglePlacement({
      x: mapped.x,
      z: mapped.z,
      terrain: this.terrain,
      expansion: this.expansion,
      settings: this.profile.placement,
      waterLevel: Number(this.config.water?.position?.[1]),
    });
    if (!placement.allowed) return null;

    const lift = Math.max(0, position.y - coastalJungleSourceElevation(position.x, position.z));
    return {
      kind,
      position: new THREE.Vector3(
        mapped.x,
        placement.height + Number(this.profile.placement?.groundOffset ?? 0.025) + lift,
        mapped.z,
      ),
      rotation: frame.rotation.clone().multiply(rotation),
      scale: scale.clone(),
    };
  }

  #batchRecord(batch, target, inverse, targetWorld, localMatrix) {
    targetWorld.compose(target.position, target.rotation, target.scale);
    localMatrix.multiplyMatrices(inverse, targetWorld);
    const record = {
      kind: target.kind,
      position: target.position,
      matrix: new Float32Array(localMatrix.elements),
      sphere: batch.localSphere?.clone().applyMatrix4(targetWorld)
        ?? new THREE.Sphere(target.position.clone(), INSTANCE_SPHERE_FALLBACK_RADIUS),
      stableFraction: coastalJungleStableFraction(target.position, target.kind),
    };
    if (this.colliderKinds.has(target.kind)) {
      record.rotation = target.rotation;
      record.scale = target.scale;
      record.instanceKey = coastalJungleInstanceKey(target.position, target.kind);
      this.colliderRecords.push(record);
    }
    return record;
  }

  async #relocateBatches(sourceBatches, signal) {
    const localMatrix = new THREE.Matrix4();
    const targetWorld = new THREE.Matrix4();
    const scatterPosition = new THREE.Vector3();
    const scatterRotation = new THREE.Quaternion();
    const scatterScale = new THREE.Vector3();
    let processed = 0;
    for (const source of sourceBatches) {
      signal?.throwIfAborted();
      if (this.disposed) return;
      const [first] = source.parts;
      const inverse = first.matrixWorld.clone().invert();
      const batch = {
        asset: source.asset,
        kind: source.kind,
        parts: source.parts,
        localSphere: partsBoundingSphere(source.parts),
        records: [],
        scatterCount: 0,
        triangles: source.parts.reduce((sum, part) => sum + trianglesPerInstance(part), 0),
        attribute: null,
        writeCount: 0,
      };
      for (const authored of source.sources) {
        if (this.#keepsAuthored(source.kind, authored.position)) {
          for (const frame of this.frames) {
            const target = this.#target(source.kind, authored.position, authored.rotation, authored.scale, frame);
            if (target) batch.records.push(this.#batchRecord(batch, target, inverse, targetWorld, localMatrix));
          }
        }
        processed += 1;
        if (this.#yieldDue(processed)) {
          await this.#yield(signal);
          if (this.disposed) return;
        }
      }
      for (const planted of source.scatter) {
        scatterPosition.set(planted.x, coastalJungleSourceElevation(planted.x, planted.z), planted.z);
        scatterRotation.setFromAxisAngle(UP, planted.yaw);
        scatterScale.setScalar(planted.scale);
        const target = this.#target(source.kind, scatterPosition, scatterRotation, scatterScale, planted.frame);
        if (target) {
          batch.records.push(this.#batchRecord(batch, target, inverse, targetWorld, localMatrix));
          batch.scatterCount += 1;
        }
        processed += 1;
        if (this.#yieldDue(processed)) {
          await this.#yield(signal);
          if (this.disposed) return;
        }
      }
      this.#allocateInstances(batch);
      this.batches.push(batch);
    }
  }

  // All parts share one buffer sized for every placed record, including the
  // scattered floor that the authored scene never carried.
  #allocateInstances(batch) {
    const capacity = Math.max(1, batch.records.length);
    const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
    attribute.setUsage(THREE.DynamicDrawUsage);
    batch.records.forEach((record, index) => attribute.array.set(record.matrix, index * 16));
    for (const part of batch.parts) {
      part.instanceMatrix = attribute;
      part.count = batch.records.length;
      part.visible = batch.records.length > 0;
    }
    batch.attribute = attribute;
  }

  async #relocateSingles(sourceSingles, signal) {
    const targetWorld = new THREE.Matrix4();
    const localMatrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    let processed = 0;
    for (const source of sourceSingles) {
      signal?.throwIfAborted();
      if (this.disposed) return;
      source.object.updateWorldMatrix(true, false);
      source.object.matrixWorld.decompose(position, rotation, scale);
      const target = this.#target(source.kind, position, rotation, scale);
      const single = {
        object: source.object,
        kind: source.kind,
        primary: source.primary,
        triangles: trianglesPerInstance(source.object),
        record: null,
      };
      this.singles.push(single);
      if (!target) {
        source.object.visible = false;
      } else {
        source.object.parent?.updateWorldMatrix(true, false);
        const parentInverse = source.object.parent?.matrixWorld?.clone().invert() ?? new THREE.Matrix4();
        targetWorld.compose(target.position, target.rotation, target.scale);
        localMatrix.multiplyMatrices(parentInverse, targetWorld);
        localMatrix.decompose(source.object.position, source.object.quaternion, source.object.scale);
        source.object.updateMatrix();
        source.object.updateWorldMatrix(true, false);
        const sphere = new THREE.Box3().setFromObject(source.object).getBoundingSphere(new THREE.Sphere());
        single.record = {
          ...target,
          sphere,
          stableFraction: coastalJungleStableFraction(target.position, target.kind),
          instanceKey: coastalJungleInstanceKey(target.position, target.kind),
        };
        if (this.colliderKinds.has(source.kind)) this.colliderRecords.push(single.record);
      }
      processed += 1;
      if (this.#yieldDue(processed)) {
        await this.#yield(signal);
        if (this.disposed) return;
      }
    }
  }

  #prepareRendering() {
    const anisotropy = Math.max(1, Number(this.profile.anisotropy ?? 8));
    const settings = this.profile.material ?? {};
    const cinematic = Boolean(this.config.cinematic?.enabled);
    this.root.traverse((object) => {
      if (!object.isMesh) return;
      object.frustumCulled = !object.isInstancedMesh;
      object.userData.excludeFromReflection = object.name !== FLOOR_NAME && object.name !== PATH_NAME;
      const kind = classifyCoastalJungleObject(object);
      const surface = object.name === FLOOR_NAME || object.name === PATH_NAME;
      const prepare = (source) => {
        if (surface || !isCoastalJungleFoliageMaterial(source, kind)) {
          prepareCoastalJungleMaterial(source, {
            kind,
            instanced: object.isInstancedMesh,
            surface,
            floor: object.name === FLOOR_NAME,
            settings,
            anisotropy,
            cinematic,
          });
          return source;
        }

        let variants = this.materialVariants.get(source);
        if (!variants) {
          variants = new Map();
          this.materialVariants.set(source, variants);
        }
        const key = `${kind ?? 'unknown'}:${object.isInstancedMesh ? 'instanced' : 'single'}`;
        if (variants.has(key)) return variants.get(key);

        const material = source.clone();
        material.name = source.name;
        prepareCoastalJungleMaterial(material, {
          kind,
          instanced: object.isInstancedMesh,
          surface: false,
          settings,
          anisotropy,
          cinematic,
        });
        variants.set(key, material);
        this.runtimeMaterials.add(material);
        return material;
      };
      object.material = Array.isArray(object.material)
        ? object.material.map(prepare)
        : prepare(object.material);
    });
  }

  #registerColliders() {
    if (!this.collisions || this.colliderRecords.length === 0) return;
    const group = this.profile.collisionGroup ?? 'coastalJungle';
    const seen = new Set();
    let index = 0;
    for (const record of this.colliderRecords) {
      const settings = this.profile.collider?.[record.kind];
      if (!settings || seen.has(record.instanceKey)) continue;
      seen.add(record.instanceKey);
      const horizontalScale = Math.max(Math.abs(record.scale.x), Math.abs(record.scale.z));
      const verticalScale = Math.abs(record.scale.y);
      const radius = Number(settings.radius) * horizontalScale;
      const height = Number(settings.height) * verticalScale;
      if (!(radius > 0) || !(height > 0)) continue;
      const position = record.position.clone();
      position.y += height * 0.5;
      const collider = this.collisions.addPreparedConvex(
        boxHull(radius, height),
        {
          position,
          rotation: record.rotation.clone(),
          scale: new THREE.Vector3(1, 1, 1),
          radius,
        },
        { group, id: `coastal-jungle-${record.kind}-${index}` },
      );
      if (collider) index += 1;
    }
    this.stats.colliders = index;
  }
}
