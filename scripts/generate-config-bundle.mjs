import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMergedConfig } from './mergedConfig.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'public', 'config.bundle.json');

export async function createConfigBundleJson() {
  return JSON.stringify(await loadMergedConfig()) + '\n';
}

export async function writeConfigBundle(output = OUTPUT) {
  await writeFile(output, await createConfigBundleJson());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeConfigBundle();
  console.log('Generated config.bundle.json');
}
