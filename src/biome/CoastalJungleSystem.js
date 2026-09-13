import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetUrl } from '../assets/assetUrl.js';
import { captureObjectResources } from '../utils/ResourceScope.js';
import { logger } from '../utils/logger.js';
import {
  isCoastalJungleFoliageMaterial,
  prepareCoastalJungleMaterial,
} from './CoastalJungleMaterial.js';
import {
  classifyCoastalJungleObject,
  coastalJungleRegionCenter,
  coastalJungleRegionRadius,
  createCoastalJungleSourceBounds,
  evaluateCoastalJunglePlacement,
  mapCoastalJungleHorizontal,
} from './CoastalJunglePlacement.js';
import { setCoastalJungleRuntimeActive } from './CoastalJungleRuntime.js';

const FLOOR_NAME = 'ForestFloor';
const PATH_NAME = 'ForestPath';
const DEFAULT_QUALITY = 'high';
const WORK_CHUNK_SIZE = 384;
const SURFACE_CHUNK_SIZE = 1024;
const COLLIDER_KINDS = new Set(['tree', 'background_tree', 'palm']);

function materialsOf(object) {
  return (Array.isArray(object?.material) ? object.material : [object?.material]).filter(Boolean);
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

function sourceRecord(matrix, kind) {
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, rotation, scale);
  return { kind, position, rotation, scale };
}

function appendObjectBounds(points, object) {
  if (!object?.isMesh) return;
  object.updateWorldMatrix(true, false);
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) return;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const z of [bounds.min.z, bounds.max.z]) points.push(new THREE.Vector3(x, 0, z));
  }
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
    this.sourceBounds = null;
    this.batches = [];
    this.singles = [];
    this.colliderRecords = [];
    this.runtimeMaterials = new Set();
    this.materialVariants = new Map();
    this.initTask = null;
    this.ready = false;
    this.disposed = false;
    this.stats = {
      active: false,
      batches: 0,
      sourceInstances: 0,
      availableInstances: 0,
      visibleInstances: 0,
      colliders: 0,
      triangles: 0,
      regionRadius: 0,
      visibilityDistance: 0,
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

    const collected = await this.#collectSource(signal);
    if (this.disposed) return;
    this.sourceBounds = createCoastalJungleSourceBounds(collected.points);
    if (!this.sourceBounds || collected.sourceInstances === 0) {
      logger.warn('Coastal jungle scene contained no recognized vegetation instances.');
      this.dispose();
      return;
    }

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

    await this.#conformSurface(collected.floor, {
      offset: Number(this.profile.placement?.groundOffset ?? 0.025),
      revealRoutes: true,
      signal,
    });
    await this.#conformSurface(collected.path, {
      offset: Number(this.profile.placement?.pathOffset ?? 0.045),
      transparent: true,
      signal,
    });
    if (this.disposed) return;

    this.#prepareRendering();
    this.#mountLod();
    this.root.updateWorldMatrix(true, true);
    this.#registerColliders();

    setCoastalJungleRuntimeActive(this.config, true);
    this.ready = true;
    this.stats.active = true;
    this.stats.sourceInstances = collected.sourceInstances;
    this.stats.availableInstances = availableInstances;
    this.stats.batches = this.batches.length;
    this.setQuality(this.qualityName);

    logger.info('Coastal jungle biome initialized.', {
      batches: this.stats.batches,
      sourceInstances: this.stats.sourceInstances,
      availableInstances: this.stats.availableInstances,
      visibleInstances: this.stats.visibleInstances,
      colliders: this.stats.colliders,
      visibilityDistance: this.stats.visibilityDistance,
    });
  }

  setQuality(name) {
    this.qualityName = name ?? DEFAULT_QUALITY;
    if (!this.ready) return;
    const quality = this.#quality();
    const shadowKinds = new Set(this.profile.shadowKinds ?? []);
    const byKind = {};
    let visibleInstances = 0;
    let triangles = 0;

    for (const batch of this.batches) {
      const density = clampDensity(quality.density?.[batch.kind] ?? 1);
      const count = Math.min(batch.availableCount, Math.round(batch.availableCount * density));
      batch.object.count = count;
      batch.object.castShadow = Boolean(quality.shadows && shadowKinds.has(batch.kind));
      batch.object.receiveShadow = true;
      byKind[batch.kind] = (byKind[batch.kind] ?? 0) + count;
      visibleInstances += count;
      triangles += batch.triangles * count;
    }

    for (const single of this.singles) {
      single.object.visible = single.accepted;
      single.object.castShadow = Boolean(single.accepted && quality.shadows && shadowKinds.has(single.kind));
      single.object.receiveShadow = true;
      if (!single.accepted) continue;
      byKind[single.kind] = (byKind[single.kind] ?? 0) + 1;
      visibleInstances += 1;
      triangles += single.triangles;
    }

    this.#applyLodDistance(quality);
    this.stats.visibleInstances = visibleInstances;
    this.stats.triangles = Math.round(triangles);
    this.stats.byKind = byKind;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    setCoastalJungleRuntimeActive(this.config, false);
    this.collisions?.removeGroup(this.profile?.collisionGroup ?? 'coastalJungle');
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
    return this.batches.reduce((sum, batch) => sum + batch.availableCount, 0)
      + this.singles.filter((single) => single.accepted).length;
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
    return Math.max(1, Number(quality?.maxDistance ?? 500)) + Math.max(0, radius);
  }

  #applyLodDistance(quality) {
    if (!this.lod || !this.farRoot) return;
    const level = this.lod.levels.find((entry) => entry.object === this.farRoot);
    const distance = this.#visibilityDistance(quality);
    if (level) level.distance = distance;
    this.lod.levels.sort((a, b) => a.distance - b.distance);
    this.stats.visibilityDistance = distance;
  }

  async #collectSource(signal) {
    const batches = [];
    const singles = [];
    const points = [];
    const candidates = [];
    let floor = null;
    let path = null;
    let sourceInstances = 0;
    const instanceMatrix = new THREE.Matrix4();
    const worldMatrix = new THREE.Matrix4();

    this.root.traverse((object) => {
      if (object.name === FLOOR_NAME) floor = object;
      if (object.name === PATH_NAME) path = object;
      const kind = classifyCoastalJungleObject(object);
      if (!kind) return;
      if (object.isInstancedMesh || (object.isMesh && object.name !== FLOOR_NAME && object.name !== PATH_NAME)) {
        candidates.push({ object, kind });
      }
    });

    let processed = 0;
    for (const { object, kind } of candidates) {
      signal?.throwIfAborted();
      if (this.disposed) return { batches, singles, points, floor, path, sourceInstances };

      if (object.isInstancedMesh) {
        const records = [];
        object.updateWorldMatrix(true, false);
        for (let index = 0; index < object.count; index += 1) {
          object.getMatrixAt(index, instanceMatrix);
          worldMatrix.multiplyMatrices(object.matrixWorld, instanceMatrix);
          const record = sourceRecord(worldMatrix, kind);
          records.push(record);
          points.push(record.position);
          sourceInstances += 1;
          processed += 1;
          if (processed % WORK_CHUNK_SIZE === 0) {
            await nextTask();
            signal?.throwIfAborted();
            if (this.disposed) return { batches, singles, points, floor, path, sourceInstances };
          }
        }
        if (records.length > 0) batches.push({ object, kind, records });
        continue;
      }

      object.updateWorldMatrix(true, false);
      const record = sourceRecord(object.matrixWorld, kind);
      singles.push({ object, ...record });
      points.push(record.position);
      sourceInstances += 1;
      processed += 1;
    }

    appendObjectBounds(points, floor);
    return { batches, singles, points, floor, path, sourceInstances };
  }

  #targetRecord(record) {
    const mapped = mapCoastalJungleHorizontal(
      record.position,
      this.sourceBounds,
      this.profile.region,
      this.config.water.sea,
    );
    if (!mapped) return null;
    const placement = evaluateCoastalJunglePlacement({
      x: mapped.x,
      z: mapped.z,
      terrain: this.terrain,
      expansion: this.expansion,
      settings: this.profile.placement,
    });
    if (!placement.allowed) return null;

    const position = new THREE.Vector3(
      mapped.x,
      placement.height + Number(this.profile.placement?.groundOffset ?? 0.025),
      mapped.z,
    );
    if (record.kind === 'vine') {
      position.y += Number(this.profile.placement?.vineAttachHeight ?? 8.5) * Math.abs(record.scale.y);
    }
    return { ...record, position, placement };
  }

  async #relocateBatches(sourceBatches, signal) {
    const localMatrix = new THREE.Matrix4();
    const targetWorld = new THREE.Matrix4();
    let processed = 0;
    for (const source of sourceBatches) {
      signal?.throwIfAborted();
      if (this.disposed) return;
      source.object.updateWorldMatrix(true, false);
      const inverse = source.object.matrixWorld.clone().invert();
      let writeIndex = 0;
      const accepted = [];
      for (const record of source.records) {
        const target = this.#targetRecord(record);
        if (target) {
          targetWorld.compose(target.position, target.rotation, target.scale);
          localMatrix.multiplyMatrices(inverse, targetWorld);
          source.object.setMatrixAt(writeIndex, localMatrix);
          accepted.push(target);
          writeIndex += 1;
        }
        processed += 1;
        if (processed % WORK_CHUNK_SIZE === 0) {
          await nextTask();
          signal?.throwIfAborted();
          if (this.disposed) return;
        }
      }
      source.object.count = writeIndex;
      source.object.instanceMatrix.needsUpdate = true;
      source.object.computeBoundingBox?.();
      source.object.computeBoundingSphere?.();
      this.batches.push({
        object: source.object,
        kind: source.kind,
        availableCount: writeIndex,
        records: accepted,
        triangles: trianglesPerInstance(source.object),
      });
      if (COLLIDER_KINDS.has(source.kind)) this.colliderRecords.push(...accepted);
    }
  }

  async #relocateSingles(sourceSingles, signal) {
    const targetWorld = new THREE.Matrix4();
    const localMatrix = new THREE.Matrix4();
    let processed = 0;
    for (const source of sourceSingles) {
      signal?.throwIfAborted();
      if (this.disposed) return;
      const target = this.#targetRecord(source);
      const single = {
        object: source.object,
        kind: source.kind,
        accepted: Boolean(target),
        triangles: trianglesPerInstance(source.object),
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
        if (COLLIDER_KINDS.has(source.kind)) this.colliderRecords.push(target);
      }
      processed += 1;
      if (processed % WORK_CHUNK_SIZE === 0) {
        await nextTask();
        signal?.throwIfAborted();
        if (this.disposed) return;
      }
    }
  }

  async #conformSurface(object, {
    offset = 0,
    transparent = false,
    revealRoutes = false,
    signal = null,
  } = {}) {
    if (!object?.isMesh || !object.geometry?.attributes?.position) return;
    object.updateWorldMatrix(true, false);
    const sourceWorldMatrix = object.matrixWorld.clone();
    const inverse = sourceWorldMatrix.clone().invert();
    const positions = object.geometry.attributes.position;
    const source = new THREE.Vector3();
    const target = new THREE.Vector3();
    for (let index = 0; index < positions.count; index += 1) {
      source.fromBufferAttribute(positions, index).applyMatrix4(sourceWorldMatrix);
      const mapped = mapCoastalJungleHorizontal(
        source,
        this.sourceBounds,
        this.profile.region,
        this.config.water.sea,
      );
      if (mapped) {
        const height = this.terrain.sampleHeight(mapped.x, mapped.z);
        if (Number.isFinite(height)) {
          const surfaceOffset = revealRoutes ? this.#routeAwareFloorOffset(mapped.x, mapped.z, offset) : offset;
          target.set(mapped.x, height + surfaceOffset, mapped.z).applyMatrix4(inverse);
          positions.setXYZ(index, target.x, target.y, target.z);
        }
      }
      if ((index + 1) % SURFACE_CHUNK_SIZE === 0) {
        await nextTask();
        signal?.throwIfAborted();
        if (this.disposed) return;
      }
    }
    positions.needsUpdate = true;
    object.geometry.computeVertexNormals();
    object.geometry.computeBoundingBox();
    object.geometry.computeBoundingSphere();
    object.castShadow = false;
    object.receiveShadow = true;
    if (transparent) {
      for (const material of materialsOf(object)) {
        material.transparent = true;
        material.depthWrite = false;
        material.polygonOffset = true;
        material.polygonOffsetFactor = -1;
        material.needsUpdate = true;
      }
      object.renderOrder = 1;
    }
  }

  #routeAwareFloorOffset(x, z, baseOffset) {
    const mask = Number(this.expansion?.paths?.sample?.(x, z) ?? 0);
    const start = Number(this.profile.placement?.routeFloorRevealStart ?? 0.08);
    if (!(mask > start)) return baseOffset;
    const reveal = THREE.MathUtils.smoothstep(mask, start, 1);
    const depth = Number(this.profile.placement?.routeFloorRevealDepth ?? 0.08);
    return THREE.MathUtils.lerp(baseOffset, -Math.abs(depth), reveal);
  }

  #prepareRendering() {
    const anisotropy = Math.max(1, Number(this.profile.anisotropy ?? 8));
    const settings = this.profile.material ?? {};
    const cinematic = Boolean(this.config.cinematic?.enabled);
    this.root.traverse((object) => {
      if (!object.isMesh) return;
      object.frustumCulled = true;
      object.userData.excludeFromReflection = object.name !== FLOOR_NAME && object.name !== PATH_NAME;
      const kind = classifyCoastalJungleObject(object);
      const surface = object.name === FLOOR_NAME || object.name === PATH_NAME;
      const prepare = (source) => {
        if (surface || !isCoastalJungleFoliageMaterial(source, kind)) {
          prepareCoastalJungleMaterial(source, {
            kind,
            instanced: object.isInstancedMesh,
            surface,
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
    let index = 0;
    for (const record of this.colliderRecords) {
      const settings = this.profile.collider?.[record.kind];
      if (!settings) continue;
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
