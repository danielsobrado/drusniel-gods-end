import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { collectCooperative } from '../foliage/vegetationRebuild.js';
import { resolvePresetConfig } from '../config/resolvePresetConfig.js';
import { ReferenceBiomeField } from './ReferenceBiomeField.js';
import {
  BiomeFootprints, generateBiomeRecords, occupiedFromWorld, selectDecorativeRecords,
} from './BiomePlacement.js';
import { loadBiomeCatalog } from './BiomeAssets.js';
import { BiomeLod, biomeCoverage } from './BiomeLod.js';
import { createBiomeBillboard, createBiomeMeshMaterial } from './BiomeMaterial.js';
import { LEAF_CUTOFF, MAIN_BATCHES, SHADOW_BATCHES } from './BiomeCatalog.js';
import { bindReferenceField } from '../rendering/PresetAppearance.js';
import { DRAW_ORDER, setOpaqueDrawOrder } from '../rendering/drawOrder.js';
import { adoptInstanceMatrices } from '../rendering/instanceMatrices.js';

const CAPACITY = 512;
const FADE_WIDTH = 24;
const KINDS = ['cactus', 'shrubSmall', 'shrubLarge', 'rockA', 'rockB'];
const MESH_LODS = { cactus: ['near', 'mid'], shrubSmall: ['near', 'mid'], shrubLarge: ['near', 'mid'],
  rockA: ['near', 'mid'], rockB: ['near', 'mid'] };

function poolKey(kind, lod) {
  return `${kind}:${lod}`;
}

export class BiomePropSystem {
  constructor({
    scene, camera, config, jobs = null, collisions = null, grass = null,
    stones = [], trees = [], props = [], catalog = null,
  } = {}) {
    this.scene = scene;
    this.camera = camera;
    this.config = config;
    this.jobs = jobs;
    this.collisions = collisions;
    this.grass = grass;
    this.stones = stones;
    this.trees = trees;
    this.props = props;
    this.injectedCatalog = catalog;
    this.qualityName = config.ui?.initialQuality ?? 'high';
    this.presetName = config.ui?.initialPreset;
    this.generation = 0;
    this.layoutRevision = 0;
    this.field = null;
    this.records = [];
    this.solids = new BiomeFootprints();
    this.occupied = new BiomeFootprints();
    this.pools = new Map();
    this.materials = [];
    this.dummy = new THREE.Object3D();
    this.cameraPosition = new THREE.Vector3();
    this.playerPosition = new THREE.Vector3();
    this.lastCell = '';
    this.lodElapsed = 1;
    this.ready = false;
    this.committed = false;
    this.disposed = false;
    this.renderEnabled = true;
    this.radius = uniform(160);
    this.fadeWidth = uniform(FADE_WIDTH);
    this.windIntensity = uniform(1);
    this.shrubBend = uniform(0.08);
    this.shrubFlutter = uniform(0.015);
    this.cactusBend = uniform(0.015);
    this.cactusFlutter = uniform(0);
    this.lodStart = uniform(18);
    this.lodEnd = uniform(24);
    this.farStart = uniform(55);
    this.farEnd = uniform(65);
    this.tint = uniform(new THREE.Color('#c8c48a'));
    this.stats = {
      batches: 0, shadowBatches: 0, triangles: 0, near: 0, mid: 0, far: 0,
      colliders: 0, bookkeepingMs: 0, records: 0,
    };
  }

  async prepare(profile, focus, { signal, generation, ecology, terrain } = {}) {
    if (this.disposed) return null;
    const jobGeneration = generation ?? ++this.generation;
    this.jobs?.cancel('biomePrepare');
    return this.#prepareSteps({
      profile, focus, signal, generation: jobGeneration, ecology, terrain,
    });
  }

  async #prepareSteps({ profile, focus, signal, generation, ecology, terrain }) {
    signal?.throwIfAborted();
    if (generation !== this.generation && generation !== undefined) {
      // Caller owns generation; keep going unless they cancelled.
    }
    const sourceEcology = ecology ?? this.grass?.vegetation;
    const sourceTerrain = terrain ?? this.grass?.terrainSampler;
    if (!sourceEcology || !sourceTerrain || !profile) return { generation, active: false };

    if (!this.catalog) {
      this.catalog = this.injectedCatalog
        ?? await loadBiomeCatalog({ config: this.config, stones: this.stones });
    }
    if (this.catalog?.missing) {
      return { generation, active: false, missing: true, error: 'biome assets are not available' };
    }

    if (!this.field || this.field.seed !== profile.seed) {
      this.field?.dispose();
      this.field = new ReferenceBiomeField(sourceEcology, profile.seed, profile.resolution ?? 1024);
      await collectCooperative(this.field.build(signal), { signal });
    }

    this.occupied = occupiedFromWorld({ trees: this.trees, props: this.props, config: this.config });
    this.solids = new BiomeFootprints();
    const waterY = (this.config.water?.position?.[1] ?? 0) - 0.1;
    const records = await collectCooperative(generateBiomeRecords({
      profile, terrain: sourceTerrain, ecology: sourceEcology, field: this.field,
      templates: Object.fromEntries(KINDS.map((kind) => [kind, this.catalog[kind] ?? {}])),
      occupied: this.occupied, solids: this.solids, waterY,
    }), { signal });
    await collectCooperative(this.field.exposeGround(this.solids), { signal });

    const quality = profile.quality?.[this.qualityName] ?? profile.quality?.high ?? {};
    const visible = selectDecorativeRecords(records, quality.shrubDensity ?? 1);
    const prepared = {
      generation,
      active: true,
      profile,
      field: this.field,
      records,
      visible,
      solids: this.solids,
      occupied: this.occupied,
      quality,
      focus: { x: focus?.x ?? 0, z: focus?.z ?? 0 },
      catalog: this.catalog,
    };
    this.pending = prepared;
    this.records = records;
    return prepared;
  }

  commit(preparedState) {
    if (this.disposed) return;
    this.collisions?.removeGroup(this.#group());
    if (!preparedState?.active) {
      this.#clearInstances();
      this.committed = false;
      this.ready = false;
      bindReferenceField(this.config, null);
      return;
    }
    this.pending = preparedState;
    this.records = preparedState.records;
    this.solids = preparedState.solids;
    this.field = preparedState.field;
    this.#ensurePools();
    this.#applyWind();
    this.#publishVisible(preparedState.focus, preparedState.visible, preparedState.quality);
    this.#commitColliders(preparedState);
    bindReferenceField(this.config, this.field);
    this.committed = true;
    this.ready = true;
    this.lastCell = '';
    this.lodElapsed = 1;
  }

  setRenderEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.renderEnabled === next) return;
    this.renderEnabled = next;
    for (const pool of this.pools.values()) {
      if (pool.mesh) pool.mesh.visible = next;
      if (pool.billboard) pool.billboard.visible = next;
    }
    if (next) {
      this.lastCell = '';
      this.lodElapsed = 1;
    }
  }

  setQuality(quality) {
    this.qualityName = quality;
    if (!this.committed || !this.pending?.active) return;
    const profile = this.pending.profile;
    const settings = profile.quality?.[quality] ?? profile.quality?.high ?? {};
    this.pending.quality = settings;
    this.pending.visible = selectDecorativeRecords(this.records, settings.shrubDensity ?? 1);
    this.lodStart.value = settings.nearStart ?? 18;
    this.lodEnd.value = settings.nearEnd ?? 24;
    this.farStart.value = settings.farStart ?? 55;
    this.farEnd.value = settings.farEnd ?? 65;
    this.lastCell = '';
  }

  setPreset(name) {
    this.presetName = name;
    this.#applyWind();
  }

  update(delta, camera, playerPosition) {
    if (!this.ready || !this.committed || !this.renderEnabled) return;
    const started = performance.now();
    const cam = camera?.position ?? camera;
    if (cam) this.cameraPosition.set(cam.x, cam.y ?? 0, cam.z);
    if (playerPosition) this.playerPosition.copy(playerPosition);
    const profile = this.pending.profile;
    const radius = profile.radius ?? 160;
    this.radius.value = radius;
    this.lodElapsed += delta;
    const cellSize = profile.cellSize ?? 32;
    const origin = this.playerPosition;
    const cell = `${Math.floor(origin.x / cellSize)},${Math.floor(origin.z / cellSize)}`;
    const teleported = this.lastCell && (
      Math.abs(Math.floor(origin.x / cellSize) - Number(this.lastCell.split(',')[0])) > 1
      || Math.abs(Math.floor(origin.z / cellSize) - Number(this.lastCell.split(',')[1])) > 1
    );
    if (cell !== this.lastCell || teleported) {
      this.lastCell = cell;
      this.#publishVisible(origin, this.pending.visible, this.pending.quality);
    } else if (this.lodElapsed >= 0.1) {
      this.#updateLod();
    }
    this.stats.bookkeepingMs = performance.now() - started;
  }

  dispose() {
    this.disposed = true;
    this.jobs?.cancel('biomePrepare');
    this.collisions?.removeGroup(this.#group());
    for (const pool of this.pools.values()) {
      pool.mesh?.removeFromParent();
      pool.mesh?.dispose?.();
      pool.billboard?.removeFromParent();
      pool.billboard?.geometry?.dispose();
      pool.billboard?.material?.dispose();
    }
    this.pools.clear();
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.field?.dispose();
    this.field = null;
    this.ready = false;
    this.committed = false;
  }

  #group() {
    return this.config.biomes?.referenceScrub?.collisionGroup ?? 'referenceBiome';
  }

  #quality() {
    return this.pending?.quality ?? {};
  }

  #applyWind() {
    const preset = resolvePresetConfig(this.config, this.presetName);
    const grass = preset?.grass?.blade;
    if (grass) this.windIntensity.value = Number(grass.windIntensity) || 0;
    const shrub = preset?.foliage?.shrub;
    if (shrub) {
      this.shrubBend.value = shrub.windBend ?? 0.08;
      this.shrubFlutter.value = shrub.windFlutter ?? 0.015;
    }
    const cactus = preset?.foliage?.cactus;
    if (cactus) {
      this.cactusBend.value = cactus.windBend ?? 0.015;
      this.cactusFlutter.value = cactus.windFlutter ?? 0;
    }
  }

  #ensurePools() {
    if (this.pools.size || !this.scene || !this.catalog) return;
    const cinematic = Boolean(this.config.cinematic?.enabled);
    const coverage = biomeCoverage(this.lodStart, this.lodEnd, this.farStart, this.farEnd);
    const shared = {
      radius: this.radius,
      fadeWidth: this.fadeWidth,
      windIntensity: this.windIntensity,
      cinematic,
      config: this.config,
      tint: this.tint,
    };
    for (const kind of KINDS) {
      const asset = this.catalog[kind];
      if (!asset) continue;
      const isRock = kind.startsWith('rock');
      const isCactus = kind === 'cactus';
      const windBend = isRock ? uniform(0) : isCactus ? this.cactusBend : this.shrubBend;
      const windFlutter = isRock ? uniform(0) : isCactus ? this.cactusFlutter : this.shrubFlutter;
      const height = uniform(asset.near?.height ?? 1);
      for (const lod of MESH_LODS[kind]) {
        const source = asset[lod];
        if (!source?.geometry) continue;
        const geometry = source.geometry.clone();
        geometry.setAttribute('clumpOrigin', new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3));
        const sourceMaterial = source.material;
        const material = createBiomeMeshMaterial({
          ...shared,
          map: sourceMaterial?.map ?? asset.atlas ?? asset.color ?? null,
          normalMap: sourceMaterial?.normalMap ?? null,
          roughnessMap: sourceMaterial?.roughnessMap ?? null,
          metalnessMap: sourceMaterial?.metalnessMap ?? null,
          normalScale: sourceMaterial?.normalScale,
          color: sourceMaterial?.color,
          roughness: sourceMaterial?.roughness,
          metalness: sourceMaterial?.metalness,
          height,
          windBend,
          windFlutter,
          cutoff: isRock ? 0 : LEAF_CUTOFF,
          coverage: lod === 'near' ? coverage.near : coverage.mid,
          wind: !isRock,
          tint: isRock ? null : this.tint,
          backlight: !isRock,
          side: isRock ? THREE.FrontSide : THREE.DoubleSide,
        });
        this.materials.push(material);
        const mesh = adoptInstanceMatrices(new THREE.InstancedMesh(geometry, material, CAPACITY));
        mesh.name = `Biome ${kind} ${lod}`;
        setOpaqueDrawOrder(mesh, DRAW_ORDER.foliage);
        mesh.count = 0;
        mesh.frustumCulled = true;
        mesh.receiveShadow = true;
        mesh.castShadow = SHADOW_BATCHES.includes(poolKey(kind, lod));
        mesh.userData.excludeFromReflection = true;
        mesh.visible = this.renderEnabled;
        this.scene.add(mesh);
        this.pools.set(poolKey(kind, lod), {
          kind, lod, mesh, matrices: new Float32Array(CAPACITY * 16),
          origins: new Float32Array(CAPACITY * 3), count: 0, height: asset.near?.height ?? 1,
          lodIndex: new BiomeLod(CAPACITY),
        });
      }
      if (!isRock && asset.far) {
        const billboard = createBiomeBillboard({
          atlas: asset.far, capacity: CAPACITY, ...shared,
          windBend, windFlutter,
          lodStart: this.lodStart, lodEnd: this.lodEnd, farStart: this.farStart, farEnd: this.farEnd,
        });
        billboard.name = `Biome ${kind} far`;
        billboard.visible = this.renderEnabled;
        this.scene.add(billboard);
        this.pools.set(poolKey(kind, 'far'), {
          kind, lod: 'far', billboard, matrices: new Float32Array(CAPACITY * 16),
          origins: new Float32Array(CAPACITY * 3), count: 0, height: asset.far.height ?? 1,
          atlas: asset.far, lodIndex: new BiomeLod(CAPACITY),
        });
      }
    }
    this.stats.batches = Math.min(this.pools.size, MAIN_BATCHES.length);
    this.stats.shadowBatches = SHADOW_BATCHES.filter((key) => this.pools.has(key)).length;
  }

  #clearInstances() {
    for (const pool of this.pools.values()) {
      pool.count = 0;
      if (pool.mesh) pool.mesh.count = 0;
      if (pool.billboard) pool.billboard.count = 0;
    }
    this.stats.near = this.stats.mid = this.stats.far = this.stats.triangles = 0;
  }

  #publishVisible(origin, records, quality) {
    const radius = this.pending?.profile?.radius ?? 160;
    const radiusSq = radius * radius;
    const grouped = { cactus: [], shrubSmall: [], shrubLarge: [], rockA: [], rockB: [] };
    for (const record of records) {
      if ((record.x - origin.x) ** 2 + (record.z - origin.z) ** 2 > radiusSq) continue;
      grouped[record.kind]?.push(record);
    }
    this.published = grouped;
    this.#applyQualityBands(quality);
    this.#updateLod();
  }

  #applyQualityBands(quality) {
    this.lodStart.value = quality?.nearStart ?? 18;
    this.lodEnd.value = quality?.nearEnd ?? 24;
    this.farStart.value = quality?.farStart ?? 55;
    this.farEnd.value = quality?.farEnd ?? 65;
  }

  #updateLod() {
    this.lodElapsed = 0;
    const camera = this.cameraPosition;
    const quality = this.#quality();
    const stats = this.stats;
    stats.near = stats.mid = stats.far = stats.triangles = 0;
    stats.records = this.records.length;
    for (const kind of KINDS) {
      const members = this.published?.[kind] ?? [];
      const origins = new Float32Array(members.length * 3);
      const matrices = new Float32Array(members.length * 16);
      for (let i = 0; i < members.length; i++) {
        const record = members[i];
        this.dummy.position.set(record.x, record.y, record.z);
        this.dummy.rotation.set(0, record.yaw, 0);
        this.dummy.scale.setScalar(record.scale);
        this.dummy.updateMatrix();
        this.dummy.matrix.toArray(matrices, i * 16);
        origins[i * 3] = record.x;
        origins[i * 3 + 1] = record.y;
        origins[i * 3 + 2] = record.z;
      }
      const lod = this.pools.get(poolKey(kind, 'near'))?.lodIndex ?? new BiomeLod(CAPACITY);
      lod.partition(origins, members.length, camera,
        quality.nearStart ?? 18, quality.nearEnd ?? 24,
        quality.farStart ?? 55, quality.farEnd ?? 65,
        { rocks: kind.startsWith('rock') });
      this.#fillPool(poolKey(kind, 'near'), lod.near, lod.nearCount, matrices, origins);
      this.#fillPool(poolKey(kind, 'mid'), lod.mid, lod.midCount, matrices, origins);
      this.#fillPool(poolKey(kind, 'far'), lod.far, lod.farCount, matrices, origins);
      stats.near += lod.nearCount;
      stats.mid += lod.midCount;
      stats.far += lod.farCount;
    }
  }

  #fillPool(key, indices, count, matrices, origins) {
    const pool = this.pools.get(key);
    if (!pool) return;
    const used = Math.min(count, CAPACITY);
    pool.count = used;
    const target = pool.mesh ?? pool.billboard;
    if (!target) return;
    for (let i = 0; i < used; i++) {
      const source = indices[i];
      pool.matrices.set(matrices.subarray(source * 16, source * 16 + 16), i * 16);
      pool.origins.set(origins.subarray(source * 3, source * 3 + 3), i * 3);
    }
    if (pool.mesh) {
      pool.mesh.instanceMatrix.array.set(pool.matrices.subarray(0, used * 16));
      pool.mesh.instanceMatrix.needsUpdate = true;
      pool.mesh.geometry.attributes.clumpOrigin.array.set(pool.origins.subarray(0, used * 3));
      pool.mesh.geometry.attributes.clumpOrigin.needsUpdate = true;
      pool.mesh.count = used;
      const triangles = (pool.mesh.geometry.index?.count ?? pool.mesh.geometry.attributes.position.count) / 3;
      this.stats.triangles += triangles * used;
      this.#expandBounds(pool.mesh, pool, used);
    }
    if (pool.billboard) {
      const attributes = pool.billboard.geometry.attributes;
      const atlas = pool.atlas;
      for (let i = 0; i < used; i++) {
        const offset = i * 16, m = pool.matrices;
        attributes.clumpOrigin.array.set(pool.origins.subarray(i * 3, i * 3 + 3), i * 3);
        const scale = Math.max(Math.hypot(m[offset], m[offset + 2]), Math.hypot(m[offset + 8], m[offset + 10]));
        attributes.billboardShape.setXYZ(i, (atlas?.width ?? 1) * scale, (atlas?.height ?? 1) * m[offset + 5],
          Math.atan2(m[offset + 8], m[offset + 10]));
      }
      pool.billboard.count = used;
      attributes.clumpOrigin.needsUpdate = attributes.billboardShape.needsUpdate = true;
      this.stats.triangles += 2 * used;
    }
  }

  #expandBounds(mesh, pool, count) {
    const padding = Math.max(pool.height, 1) * 1.6;
    const box = new THREE.Box3();
    const local = mesh.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position);
    const matrix = new THREE.Matrix4();
    const world = new THREE.Box3();
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    for (let i = 0; i < count; i++) {
      matrix.fromArray(pool.matrices, i * 16);
      world.copy(local).applyMatrix4(matrix);
      box.union(world);
    }
    if (count > 0) box.expandByScalar(padding);
    mesh.boundingBox = box;
    mesh.boundingSphere = new THREE.Sphere();
    if (!box.isEmpty()) box.getBoundingSphere(mesh.boundingSphere);
  }

  #commitColliders(prepared) {
    if (!this.collisions) return;
    const group = this.#group();
    let count = 0;
    for (const record of prepared.records) {
      if (record.decorative) continue;
      const asset = prepared.catalog[record.kind];
      const hull = asset?.hull;
      if (!hull?.length) continue;
      const scaled = hull.slice();
      for (let i = 0; i < scaled.length; i += 3) {
        scaled[i] *= record.scale;
        scaled[i + 1] *= record.scale;
        scaled[i + 2] *= record.scale;
      }
      this.collisions.addPreparedConvex(scaled, {
        position: new THREE.Vector3(record.x, record.y, record.z),
        rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), record.yaw),
        radius: record.radius,
      }, { group, id: record.id });
      count += 1;
    }
    this.collisions.setGroupEnabled(group, true);
    this.stats.colliders = count;
  }
}
