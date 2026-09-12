import yaml from 'js-yaml';
import { validateConfig } from './validateConfig.js';

export const CONFIG_FILES = [
  'config.yaml',
  'ground-material.yaml',
  'player-controls.yaml',
  'visual-parity.yaml',
  'tree-rendering.yaml',
  'character-visual.yaml',
  'cinematic-wind.yaml',
  'cinematic-look.yaml',
  'painter-cursor.yaml',
  'vegetation.yaml',
  'foliage.yaml',
  'characters.yaml',
  'reference-biome.yaml',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mergeConfig(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (isRecord(value) && isRecord(target[key])) {
      mergeConfig(target[key], value);
      continue;
    }
    target[key] = value;
  }
  return target;
}

async function loadYamlConfig(filename) {
  const url = new URL(filename, document.baseURI);
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${filename} request failed with status ${response.status}`);
  const parsed = yaml.load(await response.text());
  if (!parsed || typeof parsed !== 'object') throw new Error(`${filename} is empty or invalid`);
  return parsed;
}

export async function loadConfig() {
  const configs = await Promise.all(CONFIG_FILES.map(loadYamlConfig));
  const merged = configs.slice(1).reduce((acc, current) => mergeConfig(acc, current), configs[0]);
  return validateConfig(merged);
}
