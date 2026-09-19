import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';

const ORIGINAL_ANISOTROPY = 16;
const ORIGINAL_RAIN_ROUGHNESS = 0.1;
const TEXTURED_WORLD_NAME = 'Sketchfab_model003';
const TERRAIN_ROOT_NAME = 'TerrainRoot';

function configureTexture(texture) {
  if (!texture) return;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = ORIGINAL_ANISOTROPY;
}

export function hideCollisionHelpers(root, config = {}) {
  const names = new Set(['WaterCollider', 'HouseCollider', config.water?.colliderName,
    ...(config.collisions?.trimeshObjects ?? [])]);
  root.traverse(object => {
    if (names.has(object.name) || object.name === 'TerrainPart:colliders') object.visible = false;
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

  root.getObjectByName(TEXTURED_WORLD_NAME)?.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) configureTexture(material?.map);
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

function createLoader(config) {
  const loader = new GLTFLoader();
  const dracoPath = config.assets?.dracoDecoderPath;
  if (!dracoPath) return { loader, dracoLoader: null };
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(dracoPath);
  loader.setDRACOLoader(dracoLoader);
  return { loader, dracoLoader };
}

/**
 * Loads every terrain part and reassembles them under one root group.
 *
 * The parts are subsets of a single authored scene, so each one keeps its source
 * node names and its transforms are already world-relative to the shared root.
 * Reparenting the part scenes under `TerrainRoot` therefore restores the original
 * hierarchy for every consumer that resolves objects with `getObjectByName`.
 */
export async function loadTerrain(scene, config, onPartLoaded = () => {}) {
  const sources = resolveTerrainSources(config.assets);
  if (sources.length === 0) return { root: null, target: null, animations: [], parts: new Map() };

  const { loader, dracoLoader } = createLoader(config);

  let loaded;
  try {
    loaded = await Promise.all(sources.map(async (source) => {
      try {
        const gltf = await loader.loadAsync(assetUrl(source.path));
        onPartLoaded(source.name);
        return { source, gltf };
      } catch (error) {
        // One missing part must not cost the whole world: the systems that own
        // it fall back on their own when their named objects are absent.
        logger.warn(`Terrain part "${source.name}" failed to load; continuing without it.`, error);
        return { source, gltf: null };
      }
    }));
  } finally {
    dracoLoader?.dispose();
  }

  const present = loaded.filter((entry) => entry.gltf !== null);
  if (present.length === 0) {
    logger.warn('No terrain part loaded; using fallbacks.');
    return { root: null, target: null, animations: [], parts: new Map() };
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
  };
}
