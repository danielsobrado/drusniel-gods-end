import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { CONFIG_FILES, mergeConfig } from '../src/config/loadConfig.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export { CONFIG_FILES };

export async function loadMergedConfig() {
  const parsed = [];
  for (const filename of CONFIG_FILES) {
    const source = await readFile(path.join(ROOT, 'public', filename), 'utf8');
    const document = yaml.load(source);
    if (!document || typeof document !== 'object') {
      throw new Error(`${filename} is empty or invalid`);
    }
    parsed.push(document);
  }
  return parsed.slice(1).reduce((merged, current) => mergeConfig(merged, current), parsed[0]);
}

export function resolvePath(config, dottedPath) {
  let current = config;
  for (const segment of dottedPath.split('.')) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}
