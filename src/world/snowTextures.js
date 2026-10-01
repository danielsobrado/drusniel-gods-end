import * as THREE from 'three/webgpu';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';

// The Snow007C detail set, shared by the ground snow and the surf wake. Loaded
// once per texture config; textures are returned immediately and fill in when
// their images arrive.
const cache = new WeakMap();

function loadRepeated(loader, path, colorSpace) {
  const texture = loader.load(assetUrl(path), undefined, undefined, (error) => {
    logger.warn(`Snow detail texture failed to load: ${path}`, error);
  });
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

export function getSnowTextures(config) {
  const paths = config.ground?.snow?.textures;
  if (!paths) return null;
  if (cache.has(paths)) return cache.get(paths);
  const loader = new THREE.TextureLoader();
  const textures = {
    color: loadRepeated(loader, paths.color, THREE.SRGBColorSpace),
    normal: loadRepeated(loader, paths.normal, THREE.NoColorSpace),
    // R ambient occlusion, G roughness, B height.
    packed: loadRepeated(loader, paths.packed, THREE.NoColorSpace),
  };
  cache.set(paths, textures);
  return textures;
}

export function disposeSnowTextures(config) {
  const paths = config.ground?.snow?.textures;
  const textures = paths && cache.get(paths);
  if (!textures) return;
  for (const texture of Object.values(textures)) texture.dispose();
  cache.delete(paths);
}
