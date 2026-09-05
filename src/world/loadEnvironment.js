import * as THREE from 'three/webgpu';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';

export async function loadEnvironment(scene, config) {
  const path = config.assets?.environmentHdr;
  if (!path) return null;

  try {
    const environment = await new RGBELoader().loadAsync(assetUrl(path));
    environment.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = environment;
    scene.environmentIntensity = config.presets?.[config.ui.initialPreset]?.lighting?.environmentIntensity ?? 0.3;
    return environment;
  } catch (error) {
    logger.warn('HDR environment failed to load.', error);
    return null;
  }
}
