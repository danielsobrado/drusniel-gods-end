import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
let before = 0, after = 0;
async function optimize(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'vegetation-lods') await optimize(file); continue; }
    if (!/\.png$/i.test(file)) continue;
    const original = await readFile(file);
    const compressed = await sharp(original).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    before += original.length; after += Math.min(original.length, compressed.length);
    if (compressed.length < original.length) await writeFile(file, compressed);
    if (/^leaf-(green|yellow|whites?)(?:[-_]\d+)?\.png$/i.test(entry.name)) {
      const webp = await sharp(original).webp({ quality: 85, alphaQuality: 100, effort: 6 }).toBuffer();
      const destination = file.replace(/\.png$/i, '.webp');
      if (webp.length < Math.min(original.length, compressed.length)) await writeFile(destination, webp);
      else await unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
await optimize('public/Assets');
console.log(`Lossless PNG optimization: ${before} -> ${after} bytes. Runtime leaves use WebP with lossless alpha.`);
