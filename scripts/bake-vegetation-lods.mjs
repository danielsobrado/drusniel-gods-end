import { chromium } from './browser/node_modules/playwright/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import sharp from 'sharp';
const directory = 'public/Assets/terrain/vegetation-lods';
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => { throw error; });
  await page.goto(`${process.env.ASSET_PREVIEW_URL ?? 'http://127.0.0.1:5173'}/scripts/debug/bake-vegetation-lods.html`);
  await page.waitForFunction(() => typeof window.bakeVegetation === 'function');
  for (const [key, entry] of Object.entries(manifest.variants)) {
    const { png, ...atlas } = await page.evaluate(({ key, tree }) => window.bakeVegetation(key, tree), { key, tree: entry.tree });
    entry.atlas = `${key}.webp`;
    const encoded = await sharp(Buffer.from(png, 'base64')).webp({ quality: 82, alphaQuality: 100, effort: 6 }).toBuffer();
    await writeFile(`${directory}/${entry.atlas}`, encoded);
    Object.assign(entry, { capture: atlas });
    console.log(`Baked ${key}`);
  }
  for (const shape of ['slender', 'reed', 'broadleaf']) {
    const png = await page.evaluate(shape => window.bakeGrassClumps(shape), shape);
    await writeFile(`${directory}/grass-${shape}.webp`, await sharp(Buffer.from(png, 'base64'))
      .webp({ quality: 82, alphaQuality: 100, effort: 6 }).toBuffer());
  }
  await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
} finally { await browser.close(); }
