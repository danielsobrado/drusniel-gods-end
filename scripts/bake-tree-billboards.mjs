/** Run against the Vite dev server after assets:fantasy, then regenerate the GLBs. */
import { chromium } from './browser/node_modules/playwright/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { TEXTURE_DIRECTORY } from './stylized-tree-textures.mjs';

const manifest = JSON.parse(await readFile(`${TEXTURE_DIRECTORY}/manifest.json`, 'utf8'));
const inputs = await Promise.all(manifest.textures.map(t => readFile(`${TEXTURE_DIRECTORY}/${t.file}`)));
const sourceHash = createHash('sha256').update(Buffer.concat(inputs)).digest('hex');
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']});
try {
  const page = await browser.newPage();
  page.on('pageerror', error => { throw error; });
  await page.goto(`${process.env.ASSET_PREVIEW_URL ?? 'http://127.0.0.1:5173'}/scripts/debug/bake-tree-billboards.html`);
  for(let type=Number(process.env.TREE_BAKE_START ?? 1);type<=Number(process.env.TREE_BAKE_END ?? 11);type++) {
    const size = await page.evaluate(async type => (await window.__billboardBaker).load(type), type);
    const images = []; let positions, uvs;
    for (let side=0;side<2;side++) {
      const result = await page.evaluate(async side => (await window.__billboardBaker).render(side), side);
      images.push({input:await page.locator('canvas').screenshot({omitBackground:true}),left:result.left,top:result.top});
      positions = result.positions;
      uvs = result.uvs;
    }
    const image = await sharp({create:{...size,channels:4,background:{r:0,g:0,b:0,alpha:0}}})
      .composite(images).png({palette:true,colours:128,dither:0}).toBuffer();
    await writeFile(`${TEXTURE_DIRECTORY}/billboard-${type}.png`,image);
    await writeFile(`${TEXTURE_DIRECTORY}/billboard-${type}.json`,JSON.stringify({sourceHash,positions,uvs})+'\n');
    console.log(`Baked tree ${type}: ${Math.round(image.length/1024)} KiB`);
  }
} finally {await browser.close();}
