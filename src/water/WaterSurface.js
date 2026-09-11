import * as THREE from 'three/webgpu';
import { reflector } from 'three/tsl';
import { createCinematicWaterMaterial } from './WaterMaterial.js';
import { createLegacyWaterMaterial } from './LegacyWaterMaterial.js';
import { createWaterGeometry } from './waterGeometry.js';
import { createSeaTileGeometries, seaTileStats } from './seaGeometry.js';
import { RiverDetails } from './RiverDetails.js';
import { sampleCoastField } from '../world/CoastField.js';
import { ReflectionBudget } from './ReflectionBudget.js';
import { createReflectionCapture } from './WaterReflection.js';

export { createReflectionRenderTarget } from './WaterReflection.js';

const RAIN_THRESHOLD = 0.001;
const QUALITY_DETAIL = Object.freeze({ performance: 0.35, balanced: 0.65, high: 0.85, ultra: 1 });
const QUALITY_REFLECTION = Object.freeze({ performance: 0.25, balanced: 0.4, high: 0.75, ultra: 1 });
const DEFAULT_WATER = Object.freeze({
  size: 400,
  segments: 128,
  position: [312.7059326171875, -17, 163.0625],
  speed: 4,
  waveHeight: 0.35,
  swellHeight: 1,
  swellLength: 26.7,
  mediumHeight: 0.5,
  mediumLength: 8.3,
  smallHeight: 0.3,
  smallLength: 4.6,
  detailHeight: 0.085,
  detailLength: 2.42,
  microHeight: 0.05,
  microLength: 2,
  distortion: 1.45,
  reflectionStrength: 0.9,
  sunColor: 0xffffff,
  sunDirection: [0.707, 0.8, 0.25],
  sunStrength: 0,
  deepColor: 0x07344a,
  surfaceColor: 0x033138,
  reflectionColor: 0x1c9199,
  roughness: 0,
  metalness: 0.48,
  fresnelPower: 1,
  fresnelStrength: 1,
  reflectionResolution: 1024,
  reflectionNear: 0.1,
  reflectionFar: 1000,
  rainRipples: true,
  rainRippleStrength: 3,
  rainRippleSize: 0.32,
  rainRippleSpeed: 2.25,
  rainRippleThickness: 0.08,
  rainRippleFade: 0.55,
  rainRippleDensity: 0.95,
  rainRippleRandomness: 0.82,
});

function mergeWaterConfig(config) {
  return { ...DEFAULT_WATER, ...(config.water ?? {}) };
}

function withReflectionMask(scene, callback) {
  const hidden = [], shadows = [];
  scene.traverse((object) => {
    if (object.visible && object.userData.excludeFromReflection) {
      hidden.push(object);
      object.visible = false;
    }
    if (object.isLight && object.shadow) {
      shadows.push([object.shadow, object.shadow.autoUpdate]);
      object.shadow.autoUpdate = false;
    }
  });
  try {
    return callback();
  } finally {
    for (const object of hidden) object.visible = true;
    for (const [shadow, autoUpdate] of shadows) shadow.autoUpdate = autoUpdate;
  }
}

export class WaterSurface {
  constructor(scene, renderer, terrainRoot, terrainSampler, config, options = {}) {
    this.scene = scene;
    this.params = mergeWaterConfig(config);
    this.renderer = renderer;
    this.camera = options.camera ?? null;
    this.river = options.river;
    this.terrain = options.terrain;
    this.enhanced = Boolean(this.river || this.params.sea?.enabled);
    this.cinematic = config.cinematic?.enabled ? config.cinematic.water : null;
    if (this.cinematic) this.params.reflectionResolution = this.cinematic.reflectionResolution;
    this.reflectionElapsed = 10;
    this.reflectionInitialized = false;
    this.rippleElapsed = 0;
    this.rippleIndex = 0;
    this.lastRipple = new THREE.Vector3(1e9, 1e9, 1e9);
    this.lastCubeCaptureMs = 0;
    this.lastPlanarCaptureMs = 0;
    this.nearest = new THREE.Vector3();
    this.quality = null;
    this.seaTiles = [];
    this.stats = {
      cubeCaptures: 0,
      lakePlanarCaptures: 0,
      seaPlanarCaptures: 0,
      seaTiles: 0,
      seaVertices: 0,
      seaTriangles: 0,
      visibleSeaTiles: 0,
      visibleSeaVertices: 0,
      visibleSeaTriangles: 0,
    };
    this.viewProjection = new THREE.Matrix4();
    this.frustum = new THREE.Frustum();

    this.geometry = this.enhanced
      ? createWaterGeometry(this.params, this.river)
      : new THREE.PlaneGeometry(this.params.size, this.params.size, this.params.segments, this.params.segments);
    this.mesh = new THREE.Mesh(this.geometry);
    if (!this.enhanced) this.mesh.rotation.set(-Math.PI * 0.5, 0, 0);
    this.mesh.position.fromArray(this.params.position);
    this.mesh.name = 'River, lake and sea';
    this.mesh.userData.occlusionCull = false;

    this.reflection = createReflectionCapture(this.mesh, this.params);
    if (this.enhanced) this.#createPlanarReflections(options.camera);

    const skyColorProvider = options.skyColorProvider
      ?? scene.getObjectByName('Sky')?.userData?.getWaterColorNode
      ?? null;
    this.shader = this.enhanced
      ? createCinematicWaterMaterial({
        terrain: terrainSampler.getShaderData(),
        river: this.river,
        params: this.params,
        reflection: this.reflection.texture,
        planar: this.planar,
        seaPlanar: this.seaPlanar,
        skyColorProvider,
      })
      : createLegacyWaterMaterial(this.mesh, this.params, terrainSampler, this.reflection.texture);
    this.material = this.shader.material;
    this.uniforms = this.shader.uniforms;
    this.mesh.material = this.material;
    this.mesh.renderOrder = 1;
    this.setQuality(config.ui.initialQuality);
    scene.add(this.mesh);

    this.details = this.river
      ? new RiverDetails(scene, this.river, options.terrain, options.rockSources, options.collisions)
      : null;
    const collider = terrainRoot?.getObjectByName(config.water?.colliderName ?? 'WaterCollider');
    this.aggregateBounds = new THREE.Box3().setFromObject(this.mesh);
    this.bounds = collider ? new THREE.Box3().setFromObject(collider) : this.aggregateBounds.clone();
  }

  #createPlanarReflections(camera) {
    this.lakeReflectionBudget = new ReflectionBudget();
    this.seaReflectionBudget = new ReflectionBudget();
    this.reflectionPlaceholders = [new THREE.Texture(), new THREE.Texture()];
    this.planar = reflector({
      resolutionScale: this.cinematic?.planarReflectionScale ?? 0.75,
      bounces: false,
      generateMipmaps: true,
      defaultTexture: this.reflectionPlaceholders[0],
    });
    this.planar.target.rotation.x = -Math.PI / 2;
    this.mesh.add(this.planar.target);
    const updateLake = this.planar.reflector.updateBefore.bind(this.planar.reflector);
    this.planar.reflector.updateBefore = (frame) => {
      if (!this.reflectionInitialized || frame.camera !== camera || this.quality !== 'ultra') return;
      if (this.#coastDistance(frame.camera.position) > -60) return;
      if (!this.lakeReflectionBudget.shouldRender(frame.camera, this.quality, performance.now())) return;
      withReflectionMask(this.scene, () => {
        const started = performance.now();
        updateLake(frame);
        this.lastPlanarCaptureMs += performance.now() - started;
        this.stats.lakePlanarCaptures += 1;
      });
    };

    if (!this.params.sea?.enabled) return;
    this.seaPlanar = reflector({
      resolutionScale: this.cinematic?.planarReflectionScale ?? 0.75,
      bounces: false,
      generateMipmaps: true,
      defaultTexture: this.reflectionPlaceholders[1],
    });
    this.seaPlanar.target.rotation.x = -Math.PI / 2;
    this.seaPlanar.target.position.y = this.params.sea.level - this.params.position[1];
    this.mesh.add(this.seaPlanar.target);
    const updateSea = this.seaPlanar.reflector.updateBefore.bind(this.seaPlanar.reflector);
    this.seaPlanar.reflector.updateBefore = (frame) => {
      if (!this.reflectionInitialized || frame.camera !== camera || this.quality !== 'ultra') return;
      if (this.#coastDistance(frame.camera.position) < -350) return;
      if (!this.seaReflectionBudget.shouldRender(frame.camera, this.quality, performance.now())) return;
      withReflectionMask(this.scene, () => {
        const started = performance.now();
        updateSea(frame);
        this.lastPlanarCaptureMs += performance.now() - started;
        this.stats.seaPlanarCaptures += 1;
      });
    };
  }

  #coastDistance(position) {
    if (!this.params.sea?.enabled) return Number.NEGATIVE_INFINITY;
    return sampleCoastField(
      position.x,
      position.z,
      this.rippleElapsed,
      this.params.sea,
      this.uniforms?.rain?.value ?? 0,
    ).signedCoastDistance;
  }

  #replaceSeaTiles(quality) {
    if (!this.params.sea?.enabled) return;
    const descriptors = createSeaTileGeometries(this.params.sea, quality, this.params.position);
    const replacements = descriptors.map((descriptor, index) => {
      const mesh = new THREE.Mesh(descriptor.geometry, this.material);
      mesh.name = `Sea tile ${descriptor.acrossIndex}:${descriptor.alongIndex}`;
      mesh.renderOrder = 1;
      mesh.frustumCulled = true;
      mesh.userData.occlusionCull = false;
      mesh.userData.seaTile = true;
      mesh.userData.tileIndex = index;
      return mesh;
    });
    const previous = this.seaTiles;
    for (const tile of replacements) this.mesh.add(tile);
    this.seaTiles = replacements;
    for (const tile of previous) {
      tile.removeFromParent();
      tile.geometry.dispose();
    }
    const stats = seaTileStats(replacements);
    this.stats.seaTiles = stats.tiles;
    this.stats.seaVertices = stats.vertices;
    this.stats.seaTriangles = stats.triangles;
    this.aggregateBounds = new THREE.Box3().setFromObject(this.mesh);
  }

  #updateVisibleSeaStats(camera) {
    if (!camera || this.seaTiles.length === 0) {
      this.stats.visibleSeaTiles = 0;
      this.stats.visibleSeaVertices = 0;
      this.stats.visibleSeaTriangles = 0;
      return;
    }
    camera.updateMatrixWorld();
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection);
    let tiles = 0, vertices = 0, triangles = 0;
    for (const tile of this.seaTiles) {
      tile.updateMatrixWorld();
      if (!tile.visible || !this.frustum.intersectsObject(tile)) continue;
      tiles += 1;
      vertices += tile.geometry.attributes.position.count;
      triangles += tile.geometry.index ? tile.geometry.index.count / 3 : tile.geometry.attributes.position.count / 3;
    }
    this.stats.visibleSeaTiles = tiles;
    this.stats.visibleSeaVertices = vertices;
    this.stats.visibleSeaTriangles = triangles;
  }

  setRain(enabled) {
    if (this.uniforms.rain) this.uniforms.rain.value = enabled ? 1 : 0;
    else this.shader.setRain(enabled);
  }

  setQuality(name) {
    const changed = this.quality !== name;
    this.quality = name;
    this.lakeReflectionBudget?.reset();
    this.seaReflectionBudget?.reset();
    if (this.uniforms.rich) this.uniforms.rich.value = name === 'ultra' ? 1 : 0;
    if (this.uniforms.seaDetail) this.uniforms.seaDetail.value = QUALITY_DETAIL[name] ?? QUALITY_DETAIL.high;
    if (this.planar) this.planar.reflector.resolutionScale = QUALITY_REFLECTION[name] ?? QUALITY_REFLECTION.high;
    if (this.seaPlanar) this.seaPlanar.reflector.resolutionScale = QUALITY_REFLECTION[name] ?? QUALITY_REFLECTION.high;
    if (changed && this.material) this.#replaceSeaTiles(name);
  }

  update(delta, player, lighting) {
    this.rippleElapsed += delta;
    (this.uniforms.clock ?? this.uniforms.rippleClock).value = this.rippleElapsed;
    this.uniforms.sunColor.value.copy(lighting.color);
    this.uniforms.sunDirection.value.copy(lighting.position).normalize();
    this.uniforms.sunStrength.value = (this.enhanced ? 1 : this.params.sunStrength)
      * Math.min(lighting.directionalIntensity / 3, 1);
    const position = player.getPosition();
    const feetY = position.y - player.metrics.rootToFeet;
    const river = this.river?.sample(position.x, position.z);
    const sea = this.params.sea;
    const atSea = sea?.enabled && this.#coastDistance(position) > -30;
    const surfaceY = river?.edge < 0 ? river.y : atSea ? sea.level : this.mesh.position.y;
    if (player.moving
      && Math.abs(feetY - surfaceY) < 1.5
      && this.containsPoint(position, player.metrics.rootToFeet)
      && position.distanceTo(this.lastRipple) > 0.85) {
      this.uniforms.footsteps.array[this.rippleIndex].set(position.x, position.z, this.rippleElapsed, 1);
      this.rippleIndex = (this.rippleIndex + 1) % this.uniforms.footsteps.array.length;
      this.lastRipple.copy(position);
    }
    this.#updateVisibleSeaStats(this.camera);

    if (this.reflectionInitialized && (this.enhanced || !this.cinematic || this.quality === 'performance')) return;
    this.reflectionElapsed += delta;
    this.bounds.clampPoint(position, this.nearest);
    const distance = Math.hypot(position.x - this.nearest.x, position.z - this.nearest.z);
    const interval = (this.cinematic?.reflectionInterval ?? 1) * (this.quality === 'balanced' ? 2 : 1);
    if (this.reflectionInitialized
      && (distance > this.cinematic.reflectionDistance || this.reflectionElapsed < interval)) return;
    this.reflectionElapsed = 0;
    const camera = this.reflection.cubeCamera;
    camera.position.set(this.mesh.position.x, this.mesh.position.y + 1, this.mesh.position.z);
    const visible = this.mesh.visible;
    this.mesh.visible = false;
    this.scene.add(camera);
    try {
      withReflectionMask(this.scene, () => {
        const started = performance.now();
        camera.update(this.renderer, this.scene);
        this.lastCubeCaptureMs = performance.now() - started;
        this.reflectionInitialized = true;
        this.stats.cubeCaptures += 1;
      });
    } finally {
      this.mesh.visible = visible;
      camera.removeFromParent();
    }
  }

  setRainIntensity(value) {
    const intensity = THREE.MathUtils.clamp(Number(value), 0, 1);
    this.setRain(intensity > RAIN_THRESHOLD);
    if (this.uniforms.rain) this.uniforms.rain.value = intensity;
    if (this.enhanced) this.reflectionInitialized = false;
    this.lakeReflectionBudget?.reset();
    this.seaReflectionBudget?.reset();
    if (this.uniforms.rainRippleThickness) {
      this.uniforms.rainRippleThickness.value = THREE.MathUtils.lerp(
        0,
        this.params.rainRippleThickness,
        intensity,
      );
    }
  }

  containsPoint(position, rootToFeet = 1.5) {
    if (this.enhanced) {
      const sea = this.params.sea;
      if (sea?.enabled
        && this.#coastDistance(position) > -30
        && this.terrain.sampleHeight(position.x, position.z) <= sea.level + 0.05) {
        return position.y - rootToFeet <= sea.level + 0.5;
      }
      const p = this.river?.sample(position.x, position.z);
      if (p?.edge < 0) return position.y - rootToFeet <= p.y + 0.45;
      const half = this.params.size / 2;
      return Math.abs(position.x - this.mesh.position.x) < half
        && Math.abs(position.z - this.mesh.position.z) < half
        && this.terrain.sampleHeight(position.x, position.z) < this.mesh.position.y
        && position.y - rootToFeet <= this.mesh.position.y + 0.45;
    }
    return position.x >= this.bounds.min.x
      && position.x <= this.bounds.max.x
      && position.z >= this.bounds.min.z
      && position.z <= this.bounds.max.z
      && position.y <= this.bounds.max.y + 1.5;
  }

  dispose() {
    this.details?.dispose();
    this.planar?.dispose();
    this.seaPlanar?.dispose();
    this.reflectionPlaceholders?.forEach((texture) => texture.dispose());
    for (const tile of this.seaTiles) {
      tile.removeFromParent();
      tile.geometry.dispose();
    }
    this.seaTiles = [];
    if (this.shader.dispose) this.shader.dispose();
    else this.material?.dispose?.();
    this.scene?.remove(this.mesh);
    this.geometry?.dispose?.();
    this.reflection?.renderTarget?.dispose?.();
  }
}
