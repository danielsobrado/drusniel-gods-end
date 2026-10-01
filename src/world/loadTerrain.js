import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';
import { captureObjectResources } from '../utils/ResourceScope.js';
import { splitTerrainSources } from './terrainStreaming.js';

const ORIGINAL_RAIN_ROUGHNESS = 0.1;
const TERRAIN_ROOT_NAME = 'TerrainRoot';

export function hideCollisionHelpers(root, config = {}) {
  const names = new Set(['WaterCollider', 'HouseCollider', config.water?.colliderName,
    ...(config.collisions?.trimeshObjects ?? [])]);
  root.traverse(object => {
    if (names.has(object.name) || object.name === 'TerrainPart:colliders') {
      object.visible = false; object.userData.skipWarmup = true;
    }
  });
}

function prepareTerrainMeshes(root, config) {
  hideCollisionHelpers(root, config);
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
    object.userData.rainRoughness = ORIGINAL_RAIN_ROUGHNESS;
  });
}

/**
 * Normalises `assets.terrainParts` into `{ name, path }` records.
 *
 * A part may be written as a bare path string, as `{ name, path }`, or as a
 * single-key mapping (`- trees/tree1: Assets/terrain/trees/tree1.glb`), which is
 * what the YAML in `config.yaml` uses. `assets.terrain` is still honoured as a
 * single-file source so an unsplit GLB keeps working.
 */
export function resolveTerrainSources(assets = {}) {
  const parts = assets.terrainParts;
  const sources = [];

  if (Array.isArray(parts)) {
    for (const entry of parts) {
      if (typeof entry === 'string') {
        sources.push({ name: entry, path: entry });
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.path === 'string') {
        sources.push({ name: entry.name ?? entry.path, path: entry.path });
        continue;
      }
      const [name, path] = Object.entries(entry)[0] ?? [];
      if (typeof path === 'string') sources.push({ name, path });
    }
  }

  if (sources.length === 0 && typeof assets.terrain === 'string') {
    sources.push({ name: 'terrain', path: assets.terrain });
  }

  return sources;
}

// A shared load context owns the Draco decoder; without one (standalone
// callers and tests) each batch makes and disposes its own.
function createLoader(config, assets) {
  if (assets) return { loader: assets.createGltfLoader(), dracoLoader: null };
  const loader = new GLTFLoader();
  const dracoPath = config.assets?.dracoDecoderPath;
  if (!dracoPath) return { loader, dracoLoader: null };
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(dracoPath);
  loader.setDRACOLoader(dracoLoader);
  return { loader, dracoLoader };
}

async function loadSourceBatch(sources, config, onPartLoaded, signal, assets = null) {
  if (sources.length === 0) return [];
  const { loader, dracoLoader } = createLoader(config, assets);
  let loaded = [];
  try {
    loaded = await Promise.all(sources.map(async (source) => {
      let gltf = null;
      try {
        signal?.throwIfAborted();
        gltf = await loader.loadAsync(assetUrl(source.path));
        if (signal?.aborted) {
          captureObjectResources(gltf.scene)();
          gltf = null;
          return { source, gltf: null, aborted: true };
        }
        onPartLoaded(source.name);
        return { source, gltf };
      } catch (error) {
        if (gltf) captureObjectResources(gltf.scene)();
        if (error?.name === 'AbortError' || signal?.aborted) {
          return { source, gltf: null, aborted: true };
        }
        logger.warn(`Terrain part "${source.name}" failed to load; continuing without it.`, error);
        return { source, gltf: null };
      }
    }));

    if (signal?.aborted || loaded.some((entry) => entry.aborted)) {
      for (const entry of loaded) {
        if (entry.gltf) captureObjectResources(entry.gltf.scene)();
      }
      signal?.throwIfAborted();
      const error = new Error('Terrain loading aborted.');
      error.name = 'AbortError';
      throw error;
    }
    return loaded;
  } finally {
    dracoLoader?.dispose();
  }
}

function attachTerrainParts(root, loaded, config) {
  const parts = new Map();
  const animations = [];
  const releases = [];
  for (const { source, gltf } of loaded) {
    if (!gltf) continue;
    const partRoot = gltf.scene;
    partRoot.name = `TerrainPart:${source.name}`;
    root.add(partRoot);
    prepareTerrainMeshes(partRoot, config);
    parts.set(source.name, partRoot);
    animations.push(...gltf.animations);
    releases.push(captureObjectResources(partRoot));
  }
  root.updateWorldMatrix(true, true);
  return {
    parts,
    animations,
    dispose() {
      for (const part of parts.values()) part.removeFromParent();
      for (const release of releases.splice(0)) release();
    },
  };
}

export async function loadTerrainStreamGroup(root, group, config, { signal, onPartLoaded = () => {}, assets = null } = {}) {
  if (!root || !group?.sources?.length) return { parts: new Map(), animations: [], dispose() {} };
  const loaded = await loadSourceBatch(group.sources, config, onPartLoaded, signal, assets);
  signal?.throwIfAborted();
  return attachTerrainParts(root, loaded, config);
}

/**
 * Loads every terrain part and reassembles them under one root group.
 *
 * The parts are subsets of a single authored scene, so each one keeps its source
 * node names and its transforms are already world-relative to the shared root.
 * Reparenting the part scenes under `TerrainRoot` therefore restores the original
 * hierarchy for every consumer that resolves objects with `getObjectByName`.
 */
export async function loadTerrain(scene, config, onPartLoaded = () => {}, signal = null, { assets = null } = {}) {
  const sources = resolveTerrainSources(config.assets);
  if (sources.length === 0) {
    return { root: null, target: null, animations: [], parts: new Map(), deferredGroups: [] };
  }

  const { immediate, deferredGroups } = splitTerrainSources(sources, config);
  const loaded = await loadSourceBatch(immediate, config, onPartLoaded, signal, assets);
  const present = loaded.filter((entry) => entry.gltf !== null);
  if (present.length === 0) {
    logger.warn('No terrain part loaded; using fallbacks.');
    return { root: null, target: null, animations: [], parts: new Map(), deferredGroups };
  }

  const root = new THREE.Group();
  root.name = TERRAIN_ROOT_NAME;
  const parts = new Map();
  const animations = [];
  for (const { source, gltf } of present) {
    const partRoot = gltf.scene;
    partRoot.name = `TerrainPart:${source.name}`;
    root.add(partRoot);
    parts.set(source.name, partRoot);
    animations.push(...gltf.animations);
  }

  const terrainConfig = config.terrain ?? {};
  root.scale.setScalar(terrainConfig.scale ?? 1);
  root.position.fromArray(terrainConfig.position ?? [0, 0, 0]);
  root.rotation.y = terrainConfig.rotationY ?? 0;
  root.updateWorldMatrix(true, true);
  prepareTerrainMeshes(root, config);
  scene.add(root);

  return {
    root,
    target: root.getObjectByName(terrainConfig.targetMeshName) ?? root,
    animations,
    parts,
    deferredGroups,
  };
}
