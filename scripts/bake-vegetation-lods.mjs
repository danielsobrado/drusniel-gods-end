import { chromium } from './browser/node_modules/playwright/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import sharp from 'sharp';
import { loadMergedConfig } from './mergedConfig.mjs';

const directory = 'public/Assets/terrain/vegetation-lods';
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
const prefix = process.env.VEGETATION_BAKE_PREFIX ?? '';
const auxiliaryOnly = process.env.VEGETATION_BAKE_AUX_ONLY === '1';
const treesOnly = process.env.VEGETATION_BAKE_TREES_ONLY === '1';
const config = await loadMergedConfig();
const treeCapture = {
  views: Number(config.trees.lod.impostor.views),
  tileSize: Number(config.trees.lod.impostor.tileSize),
  gutter: Number(config.trees.lod.impostor.gutter),
};
const captureMatches = (current, next) => current
  && current.views === next.views
  && current.tileSize === next.tileSize
  && (current.gutter ?? 0) === (next.gutter ?? 0)
  && Math.abs(current.width - next.width) < 1e-5
  && Math.abs(current.height - next.height) < 1e-5
  && Array.isArray(current.center)
  && current.center.every((value, index) => Math.abs(value - next.center[index]) < 1e-5);
const browser = await chromium.launch({ headless: true, args: ['--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => { throw error; });
  await page.goto(`${process.env.ASSET_PREVIEW_URL ?? 'http://127.0.0.1:5173'}/scripts/debug/bake-vegetation-lods.html`);
  await page.waitForFunction(() => typeof window.bakeVegetation === 'function');
  for (const [key, entry] of Object.entries(manifest.variants)) {
    if (prefix && !key.startsWith(prefix)) continue;
    if ((!prefix && entry.understory) || entry.grass) continue;
    if ((auxiliaryOnly || treesOnly) && !entry.tree) continue;
    const { png, normalMaskPng, ...atlas } = await page.evaluate(
      ({ key, tree, capture }) => window.bakeVegetation(key, tree, capture),
      { key, tree: entry.tree, capture: entry.tree ? treeCapture : null },
    );
    if (auxiliaryOnly && entry.capture && !captureMatches(entry.capture, atlas)) {
      throw new Error(`${key} capture changed; run a full vegetation atlas bake before auxiliary-only mode.`);
    }
    if (!auxiliaryOnly) {
      entry.atlas = `${key}.webp`;
      delete entry.atlasKtx2;
      const encoded = await sharp(Buffer.from(png, 'base64'))
        .webp({ quality: 82, alphaQuality: 100, effort: 6 }).toBuffer();
      await writeFile(`${directory}/${entry.atlas}`, encoded);
      Object.assign(entry, { capture: atlas });
    }
    if (entry.tree && normalMaskPng) {
      entry.normalMask = `${key}-normal-mask.webp`;
      const packed = await sharp(Buffer.from(normalMaskPng, 'base64'))
        .webp({ lossless: true, effort: 6 }).toBuffer();
      await writeFile(`${directory}/${entry.normalMask}`, packed);
    }
    console.log(`Baked ${key}${auxiliaryOnly ? ' normal/mask' : ''}`);
  }
  if (!prefix && !auxiliaryOnly && !treesOnly) for (const shape of ['slender', 'reed', 'broadleaf']) {
    const key = `grass-${shape}`;
    const png = await page.evaluate(shape => window.bakeGrassClumps(shape), shape);
    await writeFile(`${directory}/${key}.webp`, await sharp(Buffer.from(png, 'base64'))
      .webp({ quality: 82, alphaQuality: 100, effort: 6 }).toBuffer());
    manifest.variants[key] = {
      ...(manifest.variants[key] ?? {}),
      tree: false,
      grass: true,
      mesh: null,
      atlas: `${key}.webp`,
      alphaCutoff: 0.5,
    };
    delete manifest.variants[key].atlasKtx2;
  }
  await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
} finally { await browser.close(); }
