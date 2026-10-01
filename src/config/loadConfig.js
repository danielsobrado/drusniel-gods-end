import { validateAlpineConfig } from './validateAlpineConfig.js';
import { validateCoastalJungleConfig } from './validateCoastalJungleConfig.js';
import { validateConfig } from './validateConfig.js';
import { validateSnowConfig } from './validateSnowConfig.js';

export const CONFIG_FILES = [
  'config.yaml',
  'ground-material.yaml',
  'surface-filtering.yaml',
  'player-controls.yaml',
  'scene.yaml',
  'audio.yaml',
  'tree-rendering.yaml',
  'character-visual.yaml',
  'cinematic-wind.yaml',
  'cinematic-look.yaml',
  'snow.yaml',
  'alpine.yaml',
  'vegetation.yaml',
  'foliage.yaml',
  'characters.yaml',
  'reference-biome.yaml',
  'coastal-jungle-runtime.yaml',
  'vegetation-lod.yaml',
  'ambient-effects.yaml',
  'surface-detail.yaml',
  'visual-refinement.yaml',
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

let yamlModule;

async function loadYamlConfig(filename) {
  const url = new URL(filename, document.baseURI);
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${filename} request failed with status ${response.status}`);
  yamlModule ??= import('js-yaml');
  const { default: yaml } = await yamlModule;
  const parsed = yaml.load(await response.text());
  if (!parsed || typeof parsed !== 'object') throw new Error(`${filename} is empty or invalid`);
  return parsed;
}

async function loadBundledConfig() {
  const url = new URL('config.bundle.json', document.baseURI);
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`config.bundle.json request failed with status ${response.status}`);
  const parsed = await response.json();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config.bundle.json is empty or invalid');
  }
  return parsed;
}

export async function loadConfig() {
  let merged;
  try {
    merged = await loadBundledConfig();
  } catch {
    const configs = await Promise.all(CONFIG_FILES.map(loadYamlConfig));
    merged = configs.slice(1).reduce((acc, current) => mergeConfig(acc, current), configs[0]);
  }
  return validateCoastalJungleConfig(
    validateAlpineConfig(validateSnowConfig(validateConfig(merged))),
  );
}
