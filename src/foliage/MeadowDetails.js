import * as THREE from 'three/webgpu';
import { createMeadowGeometry } from './MeadowGeometry.js';
import { attribute, positionGeometry, positionLocal, vec3, sin, uniform, smoothstep, cameraPosition } from 'three/tsl';
import { foliageBacklight, foliageLight } from '../rendering/CinematicLighting.js';
import { iterateMeadowDetails } from './meadowPlacement.js';
import { VegetationJob, VegetationSampleCache } from './vegetationRebuild.js';

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
  instanceGeometry.setAttribute('detailOrigin', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
  const mesh = new THREE.InstancedMesh(instanceGeometry, material, count);
  mesh.name = `Meadow ${key}`;
  mesh.userData.excludeFromReflection = true;
  mesh.userData.rainRoughness = config.props?.rainRoughness ?? 0.1;
  mesh.count = 0;
  mesh.frustumCulled = true;
  mesh.receiveShadow = true;
  mesh.castShadow = isStoneType(type);
  scene.add(mesh);
  return {
    mesh,
    matrices: new Float32Array(count * 16),
    origins: new Float32Array(count * 3),
    colors: new Float32Array(count * 3),
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

  setQuality(name) {
    this.quality = name;
    this.jobs?.cancel(this.jobId);
    this.lastCell = '';
    this.populateGeneration += 1;
  }

  update(delta, position, environment) {
    this.clock.value += delta * environment.grass.blade.simulationSpeed;
    this.wind.value = environment.grass.blade.windIntensity;
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
      const mesh = layer.mesh;
      mesh.instanceMatrix.array.set(layer.matrices.subarray(0, count * 16));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.geometry.attributes.detailOrigin.array.set(layer.origins.subarray(0, count * 3));
      mesh.geometry.attributes.detailOrigin.needsUpdate = true;
      if (!mesh.material.map) {
        if (!mesh.instanceColor) {
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(layer.colors.length), 3);
        }
        mesh.instanceColor.array.set(layer.colors.subarray(0, count * 3));
        mesh.instanceColor.needsUpdate = true;
      }
      mesh.count = count;
      mesh.computeBoundingBox();
      const height = mesh.geometry.boundingBox.max.y;
      const padding = height * height * 3 * 0.065 * 1.16 * 1.5 * 1.15;
      mesh.boundingBox.expandByScalar(padding);
      mesh.boundingSphere ??= new THREE.Sphere();
      mesh.boundingBox.getBoundingSphere(mesh.boundingSphere);
    }
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
