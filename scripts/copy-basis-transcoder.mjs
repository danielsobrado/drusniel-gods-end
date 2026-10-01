import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
const target = path.join(ROOT, 'public', 'Assets', 'vendor', 'basis');

await mkdir(target, { recursive: true });
for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
  await cp(path.join(source, file), path.join(target, file));
}
console.log('Copied Three Basis transcoder assets.');
