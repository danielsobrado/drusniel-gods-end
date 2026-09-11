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
import { expandLandscape } from './ExpandedLandscape.js';
import { createBeachScatter, disposeBeachScatter } from './BeachScatter.js';
import { createCoastalGroundcover, disposeCoastalGroundcover } from './CoastalGroundcover.js';

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

  const mapSize = window.innerWidth < shadow.mobileBreakpoint
    ? shadow.mobileMapSize
    : shadow.desktopMapSize;
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

export async function createWorld(config, onProgress = () => {}, { signal, rendererRequest, rendererOptions } = {}) {
  const scope = new ResourceScope();
  const abort = () => scope.dispose();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  scope.defer(() => signal?.removeEventListener('abort', abort));
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
    const rendererSession = await createRendererSession({
      request: rendererRequest ?? resolveRendererRequest(window.location.search, config.renderer.forceWebGL),
      options: { antialias: true, powerPreference: 'high-performance', ...rendererOptions },
      signal,
    });
    scope.defer(() => rendererSession.dispose());
    const { renderer } = rendererSession;
    renderer.setPixelRatio(getRendererPixelRatio(config));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = config.renderer.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const lights = createLights(scene, config);
    scope.defer(() => { lights.sun.shadow.dispose(); scene.remove(lights.sun, lights.sun.target, lights.hemisphere, lights.ambient); });

    onProgress('environment');
    const environment = await loadEnvironment(scene, config);
    scope.defer(() => { scene.environment = null; environment?.dispose(); });

    onProgress('world');
    const terrainAsset = await loadTerrain(scene, config);
    scope.defer(captureObjectResources(terrainAsset.root));
    const terrainAnimations = new TerrainAnimationSystem(
      terrainAsset.root,
      terrainAsset.animations,
    ).init();
    scope.defer(() => terrainAnimations.dispose());

    let terrainSampler = new TerrainSampler(terrainAsset.root, config.terrain.expansion?.enabled
      ? { ...config, terrain: { ...config.terrain, heightResolution: 384 } } : config);
    await terrainSampler.build();
    const expansion = expandLandscape(terrainAsset.target, terrainSampler, config);
    if (expansion) {
      scope.defer(() => expansion.dispose());
      terrainSampler = new TerrainSampler(terrainAsset.root, config);
      await terrainSampler.build();
      terrainSampler.river = expansion.river;
      terrainSampler.paths = expansion.paths;
      const backdrop = terrainAsset.root.getObjectByName('Landscape046');
      if (backdrop) {
        const visible = backdrop.visible;
        backdrop.visible = false;
        scope.defer(() => { backdrop.visible = visible; });
      }
    }
    scope.defer(() => terrainSampler.texture?.dispose());
    signal?.throwIfAborted();

    let groundMaterial;
    try {
      groundMaterial = await createGroundMaterial(config, terrainSampler);
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

    if (config.terrain.expansion?.enabled && config.water.sea?.enabled) {
      const beachScatter = createBeachScatter(terrainSampler, config.water.sea);
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
      environment,
      terrain: terrainAsset.root,
      terrainParts: terrainAsset.parts,
      terrainAnimationClips: terrainAsset.animations,
      terrainAnimations,
      terrainTarget: terrainAsset.target ?? ground,
      terrainSampler,
      expansion,
      sky,
      clouds,
      ...lights,
    };
  } catch (error) {
    scope.dispose();
    throw error;
  }
}
