import * as THREE from 'three';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';

const ATLAS_SIZE = 256;
const ATLAS_CELLS = 2;

function configureAtlas(texture) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createFallbackAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);

  const cell = ATLAS_SIZE / ATLAS_CELLS;
  const variants = [0.32, 0.42, 0.27, 0.36];
  variants.forEach((widthRatio, index) => {
    const column = index % ATLAS_CELLS;
    const row = Math.floor(index / ATLAS_CELLS);
    const x = column * cell;
    const y = row * cell;
    const center = x + cell * 0.5;
    const base = y + cell * 0.93;
    const tip = y + cell * 0.08;
    const halfWidth = cell * widthRatio * 0.5;

    context.fillStyle = '#ffffff';
    context.beginPath();
    context.moveTo(center - halfWidth, base);
    context.quadraticCurveTo(center - halfWidth * 0.35, y + cell * 0.44, center, tip);
    context.quadraticCurveTo(center + halfWidth * 0.35, y + cell * 0.44, center + halfWidth, base);
    context.closePath();
    context.fill();
  });

  return configureAtlas(new THREE.CanvasTexture(canvas));
}

export async function loadGrassAtlas(config) {
  const path = config.assets?.grassAtlas;
  if (!path) {
    // Shipping without an atlas is the default,
    // so the procedural fallback is the expected path, not a problem. Warning
    // about it on every boot only trains people to ignore the console.
    logger.info('Grass atlas is not configured; billboard grass uses a procedural fallback atlas.');
    return createFallbackAtlas();
  }

  try {
    return configureAtlas(await new THREE.TextureLoader().loadAsync(assetUrl(path)));
  } catch (error) {
    logger.warn('Grass atlas could not be loaded; billboard grass uses a procedural fallback atlas.', {
      path,
      error,
    });
    return createFallbackAtlas();
  }
}
