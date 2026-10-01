import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve('public/Assets/terrain/vegetation-lods');
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isFile() || !(/\.png$/.test(entry.name) || (/\.glb$/.test(entry.name) && !['forest.glb', 'jungle.glb'].includes(entry.name)))) continue;
  const file = path.resolve(directory, entry.name);
  if (path.dirname(file) !== directory) throw new Error('Unexpected derivative path');
  await unlink(file);
}
