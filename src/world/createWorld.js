import * as THREE from 'three/webgpu';
import { CloudSystem } from '../environment/CloudSystem.js';
import { SkySystem } from '../environment/SkySystem.js';
import { logger } from '../utils/logger.js';
import { createGroundMaterial } from './GroundMaterial.js';
import { getRendererPixelRatio } from './getRendererPixelRatio.js';
import { TerrainAnimationSystem } from './TerrainAnimationSystem.js';
import { TerrainSampler } from './TerrainSampler.js';
import { loadEnvironment } from './loadEnvironment.js';
import { loadTerrain } from './loadTerrain.js';
import { createRendererSession, resolveRendererRequest } from '../rendering/RendererSession.js';
import { ResourceScope, captureObjectResources } from '../utils/ResourceScope.js';
import { createExpandedLandscapeFromGeometry, expandLandscape } from './ExpandedLandscape.js';
import { loadBakedLandscapePackage } from './BakedLandscape.js';
import { createTerrainShadowChunks } from './TerrainShadowChunks.js';
import { createTerrainRenderChunks } from './TerrainRenderChunks.js';
import { createBeachScatter, disposeBeachScatter } from './BeachScatter.js';
import { createCoastalGroundcover, disposeCoastalGroundcover } from './CoastalGroundcover.js';
import { SnowDeformationField } from './SnowDeformationField.js';
import { SnowPowderSystem } from './SnowPowderSystem.js';
import { SnowSurfWake } from './SnowSurfWake.js';
import { disposeSnowTextures } from './snowTextures.js';
import { isMobileStartup } from '../config/mobileStartup.js';
import { disposeVegetationKtx2Loader } from '../foliage/VegetationKtx2Loader.js';
import { setStorageInstanceMatrices } from '../rendering/instanceMatrices.js';
import { installEmptyDrawSkip } from '../rendering/skipEmptyDraws.js';
import { loadingProfiler } from '../debug/LoadingProfiler.js';

const DEFAULT_SHADOW = {
  mobileBreakpoint: 768,
  mobileMapSize: 1024,
  desktopMapSize: 4096,
  left: -100,
  right: 100,
  top: 100,
  bottom: -100,
  near: 0.5,
  far: 200,
  bias: -0.0001,
  normalBias: 0.03,
};

function createFallbackMaterial(config) {
  return new THREE.MeshStandardMaterial({
    color: config.world.groundColor,
    roughness: config.world.groundRoughness,
    metalness: 0,
  });
}

function createFallbackGround(scene, material, config) {
  const size = Number(config.terrain.fallbackSize ?? 160);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  ground.name = 'FallbackTerrainSurface';
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  return ground;
}

function applyGroundMaterial(terrainRoot, material, config) {
  if (!terrainRoot) return [];
  const targets = [];
  for (const name of config.ground.materialTargets ?? []) {
    const target = terrainRoot.getObjectByName(name);
    if (!target?.isMesh) continue;
    target.material = material;
    target.receiveShadow = true;
    targets.push(target);
  }
  return targets;
}

function createLights(scene, config) {
  const shadow = { ...DEFAULT_SHADOW, ...(config.sun.shadow ?? {}) };
  const sun = new THREE.DirectionalLight(config.sun.color, config.sun.intensity);
  sun.position.fromArray(config.sun.position);
  sun.castShadow = true;

  const mobile = isMobileStartup(config) || window.innerWidth < shadow.mobileBreakpoint;
  const mapSize = mobile ? shadow.mobileMapSize : shadow.desktopMapSize;
  sun.shadow.mapSize.set(mapSize, mapSize);
  sun.shadow.camera.left = shadow.left;
  sun.shadow.camera.right = shadow.right;
  sun.shadow.camera.top = shadow.top;
  sun.shadow.camera.bottom = shadow.bottom;
  sun.shadow.camera.near = shadow.near;
  sun.shadow.camera.far = shadow.far;
  sun.shadow.bias = shadow.bias;
  sun.shadow.normalBias = shadow.normalBias;
  scene.add(sun);
  scene.add(sun.target);

  const hemisphere = new THREE.HemisphereLight(
    config.hemisphere.skyColor,
    config.hemisphere.groundColor,
    config.hemisphere.intensity,
  );
  scene.add(hemisphere);

  const ambient = new THREE.AmbientLight(config.ambient.color, config.ambient.intensity);
  scene.add(ambient);
  return { sun, hemisphere, ambient };
}

export async function createWorld(config, onProgress = () => {}, { signal, rendererRequest, rendererOptions, assets = null } = {}) {
  const scope = new ResourceScope();
  const abort = () => scope.dispose();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  scope.defer(() => signal?.removeEventListener('abort', abort));
  const profile = loadingProfiler();
  // Set once the terrain is handed to the scope; until then a failure elsewhere
  // must release a terrain that finished loading in parallel.
  let terrainPending = null;
  let terrainOwned = false;
  try {
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(config.world.fogColor, config.world.fogDensity);

    const camera = new THREE.PerspectiveCamera(
      config.camera.fov,
      window.innerWidth / window.innerHeight,
      config.camera.near,
      config.camera.far,
    );
    camera.position.fromArray(config.camera.initialPosition ?? [11.7, 3, 11]);

    onProgress('renderer');
    const rendererSession = await profile.measure('renderer', () => createRendererSession({
      request: rendererRequest ?? resolveRendererRequest(window.location.search, config.renderer.forceWebGL),
      options: { antialias: true, powerPreference: 'high-performance', ...rendererOptions },
      signal,
    }));
    scope.defer(() => rendererSession.dispose());
    const { renderer } = rendererSession;
    scope.defer(() => disposeVegetationKtx2Loader(renderer));
    setStorageInstanceMatrices(renderer.backend?.isWebGPUBackend === true);
    scope.defer(installEmptyDrawSkip(renderer));
    renderer.setPixelRatio(getRendererPixelRatio(config));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    // PCF keeps clean edges at 0.55 ms less GPU than PCFSoft once grass blades
    // actually receive shadows; Basic aliases visibly on the path.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = config.renderer.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const lights = createLights(scene, config);
    scope.defer(() => { lights.sun.shadow.dispose(); scene.remove(lights.sun, lights.sun.target, lights.hemisphere, lights.ambient); });

    // The environment map, the terrain parts and the baked landscape package
    // are independent requests, so they download together. Only applying the
    // baked package waits for the terrain and its sampler.
    const expandingTerrain = Boolean(config.terrain.expansion?.enabled);
    onProgress('environment');
    const environmentPending = profile.measure('environment', () => loadEnvironment(scene, config));
    terrainPending = profile.measure('terrain', () => loadTerrain(scene, config, () => {}, signal, { assets }));
    const bakedPending = expandingTerrain
      ? profile.measure('bakedTerrainPackage', () => loadBakedLandscapePackage(config, signal))
      : Promise.resolve(null);
    // Observed now; each is awaited below, and a rejection there is rethrown.
    terrainPending.catch(() => {});
    bakedPending.catch(() => {});
    const environment = await environmentPending;
    scope.defer(() => { scene.environment = null; environment?.dispose(); });

    onProgress('world');
    const terrainAsset = await terrainPending;
    terrainOwned = true;
    scope.defer(captureObjectResources(terrainAsset.root));
    const terrainStreamReleases = [];
    scope.defer(() => {
      for (const release of terrainStreamReleases.splice(0)) release();
    });
    const terrainAnimations = new TerrainAnimationSystem(
      terrainAsset.root,
      terrainAsset.animations,
    ).init();
    scope.defer(() => terrainAnimations.dispose());

    let terrainSampler = new TerrainSampler(terrainAsset.root, expandingTerrain
      ? { ...config, terrain: { ...config.terrain, heightResolution: 384 } } : config);
    await profile.measure('terrainSampler', () => (expandingTerrain
      ? terrainSampler.buildHeightOnly() : terrainSampler.build()));

    const bakedTerrain = await bakedPending;
    const endExpansion = profile.begin('landscapeExpansion');
    const expansion = bakedTerrain
      ? createExpandedLandscapeFromGeometry(
        terrainAsset.target,
        terrainSampler,
        config,
        bakedTerrain.geometry,
      )
      : expandLandscape(terrainAsset.target, terrainSampler, config);
    if (expansion) {
      scope.defer(() => expansion.dispose());
      terrainSampler = new TerrainSampler(terrainAsset.root, config);
      if (bakedTerrain?.sampler) terrainSampler.loadBaked(bakedTerrain.sampler);
      else await terrainSampler.build();
      terrainSampler.river = expansion.river;
      terrainSampler.paths = expansion.paths;
      const backdrop = terrainAsset.root.getObjectByName('Landscape046');
      if (backdrop) {
        const visible = backdrop.visible;
        const skipWarmup = backdrop.userData.skipWarmup;
        backdrop.visible = false;
        backdrop.userData.skipWarmup = true;
        scope.defer(() => { backdrop.visible = visible; backdrop.userData.skipWarmup = skipWarmup; });
      }
    }
    endExpansion();
    scope.defer(() => {
      terrainSampler.texture?.dispose();
      terrainSampler.normalTexture?.dispose();
    });
    signal?.throwIfAborted();

    const snowDeformation = config.ground.snow?.enabled && config.ground.snow.deformation?.enabled
      ? new SnowDeformationField(config, terrainSampler)
      : null;
    if (snowDeformation) scope.defer(() => snowDeformation.dispose());

    const snowPowder = config.ground.snow?.enabled && config.ground.snow.powder?.enabled
      ? new SnowPowderSystem({ scene, camera, terrainSampler, config })
      : null;
    if (snowPowder) scope.defer(() => snowPowder.dispose());

    const snowWake = config.ground.snow?.enabled && config.ground.snow.wake?.enabled
      ? new SnowSurfWake({ scene, camera, terrainSampler, config, powder: snowPowder })
      : null;
    if (snowWake) scope.defer(() => snowWake.dispose());
    // Registered before the ground material, so it is released after it.
    if (config.ground.snow?.enabled) scope.defer(() => disposeSnowTextures(config));

    let groundMaterial;
    try {
      groundMaterial = await profile.measure('groundMaterial', () => createGroundMaterial(config, terrainSampler, snowDeformation));
    } catch (error) {
      logger.warn('Ground PBR material failed to load; using fallback material.', error);
      groundMaterial = createFallbackMaterial(config);
    }
    scope.defer(() => {
      for (const texture of new Set(groundMaterial.userData.textures ?? [])) texture?.dispose();
      groundMaterial.dispose();
    });

    const materialTargets = applyGroundMaterial(terrainAsset.root, groundMaterial, config);
    const ground = terrainAsset.root
      ? (terrainAsset.target ?? materialTargets[0] ?? terrainAsset.root)
      : createFallbackGround(scene, groundMaterial, config);
    if (!terrainAsset.root) scope.defer(() => { ground.geometry.dispose(); ground.removeFromParent(); });
    const terrainRender = expansion
      ? createTerrainRenderChunks(scene, ground, terrainSampler, config)
      : null;
    terrainRender?.update(camera);
    if (terrainRender) scope.defer(() => terrainRender.dispose());
    const terrainShadows = expansion ? createTerrainShadowChunks(ground, lights.sun.shadow.camera) : null;
    if (terrainShadows) scope.defer(() => terrainShadows.dispose());

    if (config.terrain.expansion?.enabled && config.water.sea?.enabled) {
      const beachScatter = createBeachScatter(terrainSampler, config.water.sea, config);
      scene.add(beachScatter);
      scope.defer(() => disposeBeachScatter(beachScatter));

      const groundcover = createCoastalGroundcover(
        terrainSampler,
        config.water.sea,
        config.ui.initialQuality,
      );
      scene.add(groundcover);
      scope.defer(() => disposeCoastalGroundcover(groundcover));
    }

    let sky = null;
    let clouds = null;
    try {
      sky = new SkySystem(scene, config);
      scope.defer(() => sky.dispose());
      clouds = new CloudSystem(scene, config);
      scope.defer(() => clouds.dispose());
    } catch (error) {
      logger.warn('Procedural TSL sky/cloud setup failed; continuing without it.', error);
      scene.background = new THREE.Color(config.world.skyColor);
    }

    return {
      scene,
      camera,
      renderer,
      rendererSession,
      dispose: () => scope.dispose(),
      ground,
      groundMaterial,
      environment,
      terrain: terrainAsset.root,
      terrainParts: terrainAsset.parts,
      terrainDeferredGroups: terrainAsset.deferredGroups ?? [],
      registerTerrainStreamRelease: (release) => {
        if (typeof release !== 'function') return;
        if (scope.disposed) {
          release();
          return;
        }
        terrainStreamReleases.push(release);
      },
      terrainAnimationClips: terrainAsset.animations,
      terrainAnimations,
      terrainTarget: terrainAsset.target ?? ground,
      terrainRender,
      terrainShadows,
      shadowCamera: lights.sun.shadow.camera,
      terrainSampler,
      expansion,
      snowDeformation,
      snowPowder,
      snowWake,
      sky,
      clouds,
      ...lights,
    };
  } catch (error) {
    if (terrainPending && !terrainOwned) {
      terrainPending.then((asset) => captureObjectResources(asset.root)(), () => {});
    }
    scope.dispose();
    throw error;
  }
}
