import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';

const EMPTY_DATA = Object.freeze({ stones: [], lanterns: [] });

export async function loadWorldPropData(config) {
  const path = config.assets?.worldProps;
  if (!path) return EMPTY_DATA;

  try {
    const response = await fetch(assetUrl(path), { cache: 'no-store' });
    if (!response.ok) throw new Error(`World prop data request failed with status ${response.status}`);
    const data = await response.json();
    return {
      stones: Array.isArray(data?.stones) ? data.stones : [],
      lanterns: Array.isArray(data?.lanterns) ? data.lanterns : [],
    };
  } catch (error) {
    logger.warn('World prop data failed to load; continuing without props.', error);
    return EMPTY_DATA;
  }
}
