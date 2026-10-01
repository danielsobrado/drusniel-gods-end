import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { foliageMipmaps } from '../src/foliage/alphaCoverage.js';
import { ktx2MipChain, sharpenCutoutAlpha } from './vegetationKtx2Mips.mjs';

const DIRECTORY = 'public/Assets/terrain/vegetation-lods';
const MANIFEST = `${DIRECTORY}/manifest.json`;
const TOKTX = process.env.TOKTX ?? 'toktx';
const PREFIX = process.env.VEGETATION_ENCODE_PREFIX ?? '';
const TREES_ONLY = process.env.VEGETATION_ENCODE_TREES_ONLY === '1';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'grass-ktx2-'));

try {
  for (const [key, entry] of Object.entries(manifest.variants)) {
    if (PREFIX && !key.startsWith(PREFIX)) continue;
    if (TREES_ONLY && !entry.tree) continue;
    if (!entry.atlas) continue;

    const source = path.join(DIRECTORY, entry.atlas);
    const outputName = `${key}.ktx2`;
    const output = path.join(DIRECTORY, outputName);
    const { data, info } = await sharp(source)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const levels = ktx2MipChain(foliageMipmaps(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      info.width,
      info.height,
      Number(entry.alphaCutoff) || 0.35,
    ));
    const mipFiles = [];
    for (let level = 0; level < levels.length; level += 1) {
      const mip = sharpenCutoutAlpha(levels[level], Number(entry.alphaCutoff) || 0.35);
      const file = path.join(temporary, `${key}-${level}.png`);
      await sharp(Buffer.from(mip.data), {
        raw: { width: mip.width, height: mip.height, channels: 4 },
      }).png().toFile(file);
      mipFiles.push(file);
    }

    await run(TOKTX, [
      '--t2',
      '--2d',
      '--mipmap',
      // The chain stops before ETC1S loses the cutout (see ktx2MipChain), so the
      // pyramid is partial and toktx has to be told how many levels to expect.
      '--levels', String(levels.length),
      '--lower_left_maps_to_s0t0',
      '--encode', 'etc1s',
      '--clevel', '5',
      '--qlevel', '192',
      '--assign_oetf', 'srgb',
      '--assign_primaries', 'bt709',
      '--',
      output,
      ...mipFiles,
    ]);

    entry.atlasKtx2 = outputName;
    console.log(`Encoded ${key} -> ${outputName}`);
  }

  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
