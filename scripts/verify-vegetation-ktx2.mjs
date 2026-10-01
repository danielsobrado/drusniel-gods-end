import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { foliageMipmaps } from '../src/foliage/alphaCoverage.js';
import { ktx2MipChain } from './vegetationKtx2Mips.mjs';
import { loadMergedConfig } from './mergedConfig.mjs';

const DIRECTORY = 'public/Assets/terrain/vegetation-lods';
const PREFIX = process.env.VEGETATION_VERIFY_PREFIX ?? '';
const TREES_ONLY = process.env.VEGETATION_VERIFY_TREES_ONLY === '1';
const KTX = process.env.KTX ?? 'ktx';
const KTX2_IDENTIFIER = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MAX_ALPHA_COVERAGE_RELATIVE_ERROR = 0.12;
const MIN_ALPHA_COVERAGE_REFERENCE = 0.02;

function alphaCoverage(data, cutoff) {
  let covered = 0;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] / 255 >= cutoff) covered += 1;
  }
  return covered / Math.max(1, data.length / 4);
}

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

const manifest = JSON.parse(await readFile(path.join(DIRECTORY, 'manifest.json'), 'utf8'));
const entries = Object.entries(manifest.variants)
  .filter(([key, entry]) => entry.atlas
    && (!PREFIX || key.startsWith(PREFIX))
    && (!TREES_ONLY || entry.tree));

if (entries.length === 0) {
  throw new Error(`No vegetation atlas entries matched prefix "${PREFIX}".`);
}

const config = await loadMergedConfig();
const maxTransferRatio = Number(config.vegetationLod?.ktx2?.maxTransferRatio);
let sourceBytes = 0;
let compressedBytes = 0;
const temporary = await mkdtemp(path.join(os.tmpdir(), 'grass-ktx2-verify-'));

try {
  for (const [key, entry] of entries) {
    if (!entry.atlasKtx2) throw new Error(`${key} is missing atlasKtx2 in the manifest.`);

    const source = path.join(DIRECTORY, entry.atlas);
    const file = path.join(DIRECTORY, entry.atlasKtx2);
    const metadata = await stat(file);
    if (metadata.size <= 64) throw new Error(`${key} KTX2 file is unexpectedly small.`);

    sourceBytes += (await stat(source)).size;
    compressedBytes += metadata.size;

    const header = await readFile(file);
    if (!header.subarray(0, KTX2_IDENTIFIER.length).equals(KTX2_IDENTIFIER)) {
      throw new Error(`${key} does not have a valid KTX2 identifier.`);
    }

    const levelCount = header.readUInt32LE(40);
    if (levelCount < 2) {
      throw new Error(`${key} KTX2 must contain mipmaps; found ${levelCount} level(s).`);
    }
    await run(KTX, ['validate', '--warnings-as-errors', file]);

    const cutoff = Number(entry.alphaCutoff) || 0.35;
    const { data: sourceData, info: sourceInfo } = await sharp(source)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const expectedLevels = ktx2MipChain(foliageMipmaps(
      new Uint8Array(sourceData.buffer, sourceData.byteOffset, sourceData.byteLength),
      sourceInfo.width,
      sourceInfo.height,
      cutoff,
    ));
    if (expectedLevels.length !== levelCount) {
      throw new Error(
        `${key} expected ${expectedLevels.length} mip levels but KTX2 contains ${levelCount}.`,
      );
    }

    const extractDirectory = path.join(temporary, key);
    await run(KTX, ['extract', '--level', 'all', '--transcode', 'rgba8', file, extractDirectory]);

    for (let level = 0; level < expectedLevels.length; level += 1) {
      const expected = expectedLevels[level];
      const decodedPath = path.join(extractDirectory, `output_level${level}.png`);
      const { data: decoded, info } = await sharp(decodedPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (info.width !== expected.width || info.height !== expected.height) {
        throw new Error(
          `${key} mip ${level} dimensions ${info.width}x${info.height} do not match `
          + `${expected.width}x${expected.height}.`,
        );
      }

      const expectedCoverage = alphaCoverage(expected.data, cutoff);
      const decodedCoverage = alphaCoverage(decoded, cutoff);
      const relativeError = Math.abs(decodedCoverage - expectedCoverage)
        / Math.max(MIN_ALPHA_COVERAGE_REFERENCE, expectedCoverage);
      if (relativeError > MAX_ALPHA_COVERAGE_RELATIVE_ERROR) {
        throw new Error(
          `${key} mip ${level} alpha coverage changed by ${(relativeError * 100).toFixed(1)}% `
          + `(${expectedCoverage.toFixed(4)} -> ${decodedCoverage.toFixed(4)}).`,
        );
      }
    }
  }

  if (!(maxTransferRatio >= 1) || !Number.isFinite(maxTransferRatio)) {
    throw new Error(
      'vegetationLod.ktx2.maxTransferRatio must be configured before KTX2 verification.',
    );
  }

  const transferRatio = compressedBytes / Math.max(1, sourceBytes);
  if (transferRatio > maxTransferRatio) {
    throw new Error(
      `KTX2 transfer payload is ${transferRatio.toFixed(2)}x WebP, `
      + `above configured ${maxTransferRatio}x maximum.`,
    );
  }

  console.log(
    `Verified ${entries.length} KTX2 vegetation atlases${PREFIX ? ` for ${PREFIX}` : ''}: `
    + `${(compressedBytes / 1048576).toFixed(2)} MiB, ${transferRatio.toFixed(2)}x WebP.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
