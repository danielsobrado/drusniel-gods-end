import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
const rows = [];
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!['tmp', 'node_modules'].includes(entry.name)) await scan(file); continue; }
    if (!/\.(png|jpe?g|webp)$/i.test(file)) continue;
    const info = await sharp(file).metadata(), { size } = await stat(file);
    rows.push({ file: file.replaceAll('\\', '/'), bytes: size, width: info.width, height: info.height, alpha: info.hasAlpha });
  }
}
await scan('public'); rows.sort((a, b) => b.bytes - a.bytes);
await writeFile('.cache/web-images.json', JSON.stringify(rows, null, 2));
console.log(JSON.stringify({ count: rows.length, bytes: rows.reduce((n, r) => n + r.bytes, 0), largest: rows.slice(0, 25) }, null, 2));
