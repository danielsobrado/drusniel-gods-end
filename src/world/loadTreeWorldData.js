import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';

export async function loadTreeWorldData(config) {
  const path = config.assets?.treeWorld;
  if (!path) return null;

  try {
    const response = await fetch(assetUrl(path), { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Tree world request failed with status ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Tree world data must be an array.');
    return data;
  } catch (error) {
    logger.warn('Tree world data failed to load; falling back to GLB markers.', error);
    return null;
  }
}
