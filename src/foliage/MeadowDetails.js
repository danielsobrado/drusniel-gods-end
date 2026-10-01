import * as THREE from 'three/webgpu';
import { createMeadowGeometry } from './MeadowGeometry.js';
import { attribute, positionGeometry, positionLocal, vec3, sin, uniform, smoothstep, cameraPosition } from 'three/tsl';
import { foliageBacklight, foliageLight } from '../rendering/CinematicLighting.js';
import { iterateMeadowDetails } from './meadowPlacement.js';
import { VegetationJob, VegetationSampleCache } from './vegetationRebuild.js';
import { sampleSnowSurfaceCpu } from '../world/SnowDeformationField.js';
import {
  InstanceViewCuller, IncrementalViewCull, InstanceSelectionMemo, InstanceSphereCache,
  copySelectedInstances, markAttributeUpdate,
} from './InstanceViewCuller.js';
import { DRAW_ORDER } from '../rendering/drawOrder.js';
import { adoptInstanceMatrices } from '../rendering/instanceMatrices.js';

function isStoneType(type) {
  return type === 'stone' || String(type).startsWith('stone:');
}

function sourceMaterial(source) {
  return Array.isArray(source?.material) ? source.material[0] : source?.material;
}

function createMeadowLayer({
  scene, config, radius, clock, wind, type, geometry, map = null, roughness = 0.9, key = type, disposeSource = false,
}) {
  const staticDetail = type === 'litter' || isStoneType(type);
  const texturedStone = isStoneType(type) && map;
  const material = new THREE.MeshStandardNodeMaterial({
    side: texturedStone ? THREE.FrontSide : THREE.DoubleSide,
    vertexColors: !texturedStone,
    roughness,
    metalness: 0,
    map: map ?? null,
  });
  const origin = attribute('detailOrigin', 'vec3');
  const distance = origin.xz.sub(cameraPosition.xz).length();
  const fade = smoothstep(radius - 18, radius, distance).oneMinus();
  const phase = clock.mul(type === 'fern' ? 1.25 : 1.8).add(origin.x.mul(0.13)).add(origin.z.mul(0.08));
  const heightWeight = positionGeometry.y.max(0).pow(2);
  const sway = sin(phase).add(sin(phase.mul(1.7).add(positionGeometry.x.mul(3))).mul(0.16))
    .mul(wind.clamp(0, 3)).mul(heightWeight).mul(staticDetail ? 0 : 0.065);
  const root = origin.sub(vec3(0, 0.015, 0));
  material.positionNode = positionLocal.sub(root).add(vec3(sway, 0, sway.mul(0.35))).mul(fade).add(root);
  if (!texturedStone) {
    const pigment = attribute('color', 'vec3');
    const fill = config.cinematic.style?.enabled ? (config.cinematic.style.foliageFill ?? 0.28) : 0;
    material.emissiveNode = foliageBacklight(pigment, staticDetail ? 0 : config.cinematic.vegetation.backlight)
      .add(pigment.mul(foliageLight.fill).mul(staticDetail ? fill * 0.35 : fill));
  }
  const count = config.cinematic.vegetation.count;
  const instanceGeometry = geometry.clone();
  if (disposeSource) geometry.dispose();
  if (!instanceGeometry.boundingBox) instanceGeometry.computeBoundingBox();
  if (!instanceGeometry.boundingSphere) instanceGeometry.computeBoundingSphere();
  instanceGeometry.setAttribute('detailOrigin', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
  const mesh = adoptInstanceMatrices(new THREE.InstancedMesh(instanceGeometry, material, count));
  mesh.name = `Meadow ${key}`;
  mesh.renderOrder = DRAW_ORDER.foliage;
  mesh.userData.excludeFromReflection = true;
  mesh.userData.rainRoughness = config.props?.rainRoughness ?? 0.1;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = isStoneType(type);
  scene.add(mesh);
  return {
    mesh,
    matrices: new Float32Array(count * 16),
    origins: new Float32Array(count * 3),
    colors: new Float32Array(count * 3),
    publishedMatrices: new Float32Array(count * 16),
    publishedOrigins: new Float32Array(count * 3),
    publishedColors: new Float32Array(count * 3),
    publishedCount: 0,
    publishedRevision: 0,
    sphereCache: new InstanceSphereCache(),
    selection: new InstanceSelectionMemo(),
    localSphere: instanceGeometry.boundingSphere.clone(),
    visibleIndices: new Uint32Array(count),
    stagingCount: 0,
  };
}

export class MeadowDetails {
  constructor(scene, config, terrain, grass, trees, pebbleSources = [], options = {}) {
    this.scene = scene;
    this.config = config;
    this.terrain = terrain;
    this.grass = grass;
    this.trees = trees;
    this.radius = config.cinematic.vegetation.radius;
    this.clock = uniform(0);
    this.wind = uniform(0.2);
    this.lastCell = '';
    this.jobs = options.jobs ?? null;
    this.viewCuller = new InstanceViewCuller(options.camera ?? null, config.vegetation?.viewCulling);
    this.viewCull = new IncrementalViewCull(options.viewCullBudget ?? null);
    this.cullMs = 0;
    this.cullUnits = null;
    this.stats = { instances: 0, visibleInstances: 0, culledInstances: 0, cullingMs: 0 };
    this.jobId = 'meadow';
    this.populateGeneration = 0;
    this.sampleCache = new VegetationSampleCache();
    this.dummy = new THREE.Object3D();
    this.color = new THREE.Color();
    this.meshes = new Map();
    this.layers = new Map();
    this.stoneMeshes = [];
    this.stoneLayers = [];
    this.quality = config.ui.initialQuality;
    this.renderEnabled = true;
    const layer = (type, geometry, extra = {}) => {
      const created = createMeadowLayer({
        scene,
        config,
        radius: this.radius,
        clock: this.clock,
        wind: this.wind,
        type,
        geometry,
        ...extra,
      });
      this.meshes.set(extra.key ?? type, created.mesh);
      this.layers.set(extra.key ?? type, created);
      return created;
    };
    for (const type of ['flower', 'seed', 'fern', 'reed', 'litter']) {
      layer(type, createMeadowGeometry(type), { disposeSource: true });
    }
    const pebbles = (pebbleSources ?? []).filter((source) => source?.geometry);
    if (pebbles.length > 0) {
      for (const [index, pebble] of pebbles.entries()) {
        const material = sourceMaterial(pebble);
        const key = pebbles.length === 1 ? 'stone' : `stone:${index}`;
        const created = layer('stone', pebble.geometry, {
          key,
          map: material?.map ?? null,
          roughness: material?.roughness ?? 0.88,
        });
        this.stoneMeshes.push(created.mesh);
        this.stoneLayers.push(created);
      }
    } else {
      const created = layer('stone', createMeadowGeometry('stone'), { disposeSource: true });
      this.stoneMeshes.push(created.mesh);
      this.stoneLayers.push(created);
    }
  }

  setRenderEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.renderEnabled === next) return;
    this.renderEnabled = next;
    if (!next) {
      this.jobs?.cancel(this.jobId);
      this.viewCull.cancel();
    }
    for (const mesh of this.meshes.values()) mesh.visible = next;
    if (next) {
      this.viewCuller.markDirty();
      this.lastCell = '';
    }
  }

  setQuality(name) {
    this.quality = name;
    this.jobs?.cancel(this.jobId);
    this.lastCell = '';
    this.populateGeneration += 1;
  }

  update(delta, position, environment) {
    if (!this.renderEnabled) return;
    this.clock.value += delta * environment.grass.blade.simulationSpeed;
    this.wind.value = environment.grass.blade.windIntensity;
    if (this.viewCuller.update()) this.#requestViewCull();
    this.#drainViewCull();
    const cx = Math.floor(position.x / 12);
    const cz = Math.floor(position.z / 12);
    const cell = `${cx},${cz}`;
    if (cell === this.lastCell) return;
    this.lastCell = cell;
    this.#startPopulate(position);
  }

  #startPopulate(origin) {
    const generation = ++this.populateGeneration;
    const generate = () => iterateMeadowDetails({
      origin,
      radius: this.radius,
      quality: this.quality,
      config: this.config,
      stoneCount: this.stoneLayers.length,
      stoneHasColor: this.stoneLayers.map((layer) => !layer.mesh.material.map),
      cache: this.sampleCache,
      contains: (x, z) => this.terrain.contains(x, z, 2),
      sampleHeight: (x, z) => this.terrain.sampleHeight(x, z),
      sampleEcology: (x, z) => this.grass.sampleVegetation(x, z),
      sampleRiverEdge: (x, z) => this.terrain.river?.sample(x, z)?.edge ?? 100,
      sampleSnow: (x, z) => sampleSnowSurfaceCpu(this.terrain, x, z, 1, this.config)?.coverage ?? 0,
    });
    const publish = () => {
      if (generation !== this.populateGeneration) return;
      this.#publishStaging();
    };
    if (!this.jobs) {
      this.#resetStaging();
      for (const item of generate()) {
        if (item) this.#stageItem(item);
      }
      publish();
      return;
    }
    this.jobs.replace(this.jobId, new VegetationJob({
      generate,
      consume: (item) => this.#stageItem(item),
      reset: () => this.#resetStaging(),
      publish,
    }));
  }

  #resetStaging() {
    for (const layer of this.layers.values()) layer.stagingCount = 0;
  }

  #stageItem(item) {
    const layer = item.type === 'stone'
      ? this.stoneLayers[item.stoneIndex] ?? this.stoneLayers[0]
      : this.layers.get(item.type);
    if (!layer) return;
    const capacity = layer.matrices.length / 16;
    if (layer.stagingCount >= capacity) return;
    const index = layer.stagingCount++;
    this.dummy.position.set(item.x, item.y, item.z);
    this.dummy.rotation.set(0, item.yaw, 0);
    this.dummy.scale.set(item.scaleX, item.scaleY, item.scaleZ);
    this.dummy.updateMatrix();
    this.dummy.matrix.toArray(layer.matrices, index * 16);
    layer.origins[index * 3] = item.x;
    layer.origins[index * 3 + 1] = item.originY;
    layer.origins[index * 3 + 2] = item.z;
    this.color.setHSL(item.hue, item.saturation, item.lightness);
    layer.colors[index * 3] = this.color.r;
    layer.colors[index * 3 + 1] = this.color.g;
    layer.colors[index * 3 + 2] = this.color.b;
  }

  #publishStaging() {
    for (const layer of this.layers.values()) {
      const count = layer.stagingCount;
      layer.publishedMatrices.set(layer.matrices.subarray(0, count * 16));
      layer.publishedOrigins.set(layer.origins.subarray(0, count * 3));
      layer.publishedColors.set(layer.colors.subarray(0, count * 3));
      layer.publishedCount = count;
      layer.publishedRevision += 1;
      layer.sphereCache.invalidate();
    }
    this.viewCuller.update(true);
    this.viewCull.restart();
  }

  #cullUnits() {
    if (!this.cullUnits || this.cullUnits.length !== this.layers.size) {
      this.cullUnits = [...this.layers.values()];
    }
    return this.cullUnits;
  }

  #requestViewCull() {
    this.viewCull.request();
  }

  #resetViewCullStats() {
    this.stats.instances = 0;
    this.stats.visibleInstances = 0;
    this.stats.culledInstances = 0;
    this.stats.cullingMs = 0;
    this.cullMs = 0;
  }

  #drainViewCull() {
    if (!this.viewCull.pending) return;
    const started = performance.now();
    const complete = this.viewCull.step(
      this.#cullUnits(),
      (layer) => this.#applyLayer(layer),
      () => this.#resetViewCullStats(),
    );
    this.cullMs += performance.now() - started;
    if (complete) {
      this.stats.culledInstances = this.stats.instances - this.stats.visibleInstances;
      this.stats.cullingMs = this.cullMs;
    }
  }

  #applyLayer(layer) {
    const stats = this.stats;
    const total = layer.publishedCount;
    const visible = this.viewCuller.collectVisible(
      layer.publishedMatrices,
      total,
      layer.localSphere,
      layer.visibleIndices,
      layer.sphereCache,
    );
    const mesh = layer.mesh;
    stats.instances += total;
    stats.visibleInstances += visible;
    if (layer.selection.matches(layer.publishedRevision, layer.visibleIndices, visible)) {
      mesh.count = visible;
      return;
    }
    copySelectedInstances(
      layer.publishedMatrices,
      mesh.instanceMatrix.array,
      16,
      layer.visibleIndices,
      visible,
    );
    copySelectedInstances(
      layer.publishedOrigins,
      mesh.geometry.attributes.detailOrigin.array,
      3,
      layer.visibleIndices,
      visible,
    );
    markAttributeUpdate(mesh.instanceMatrix, visible);
    markAttributeUpdate(mesh.geometry.attributes.detailOrigin, visible);
    if (!mesh.material.map) {
      if (!mesh.instanceColor) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(layer.colors.length), 3);
      }
      copySelectedInstances(
        layer.publishedColors,
        mesh.instanceColor.array,
        3,
        layer.visibleIndices,
        visible,
      );
      markAttributeUpdate(mesh.instanceColor, visible);
    }
    mesh.count = visible;
  }

  dispose() {
    this.jobs?.cancel(this.jobId);
    this.sampleCache.clear();
    for (const mesh of this.meshes.values()) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.dispose();
    }
  }
}
