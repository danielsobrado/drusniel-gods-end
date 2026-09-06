// scripts/stage-audio-sources.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const STAGING_DIR = path.resolve('.cache/audio-sources');
const UNPACKED_DIR = path.join(STAGING_DIR, 'unpacked');

const SOURCES = [
  { id: 'wind-loop', url: 'https://opengameart.org/sites/default/files/wind%20woosh%20loop.ogg', file: 'wind_woosh_loop.ogg' },
  { id: 'wind-pack', url: 'https://opengameart.org/sites/default/files/wind.zip', file: 'wind.zip', archive: true },
  { id: 'forest', url: 'https://opengameart.org/sites/default/files/Forest_Ambience.mp3', file: 'Forest_Ambience.mp3' },
  { id: 'birds-chirping', url: 'https://opengameart.org/sites/default/files/birdchirping071414_0.mp3', file: 'birdchirping071414.mp3' },
  { id: 'birds-ambient', url: 'https://opengameart.org/sites/default/files/birds-isaiah658_0.ogg', file: 'birds-isaiah658.ogg' },
  { id: 'crow', url: 'https://opengameart.org/sites/default/files/crow_0.ogg', file: 'crow.ogg' },
  { id: 'crows', url: 'https://opengameart.org/sites/default/files/Crows.ogg', file: 'Crows.ogg' },
  { id: 'birds-crickets-pack', url: 'https://opengameart.org/sites/default/files/birdsCrickets.zip', file: 'birdsCrickets.zip', archive: true },
  { id: 'crickets', url: 'https://opengameart.org/sites/default/files/cricketsounds090613_0.mp3', file: 'cricketsounds090613.mp3' },
  { id: 'swamp', url: 'https://opengameart.org/sites/default/files/swamp.ogg', file: 'swamp.ogg' },
  { id: 'water-sfx-pack', url: 'https://opengameart.org/sites/default/files/water-splash-slime-sfx.zip', file: 'water-splash-slime-sfx.zip', archive: true },
  { id: 'water-splashes-pack', url: 'https://opengameart.org/sites/default/files/ezwa-water_splash.7z', file: 'ezwa-water_splash.7z', archive: true },
  { id: 'different-steps-pack', url: 'https://opengameart.org/sites/default/files/%5Bkdd%5DDifferentSteps_0.zip', file: 'DifferentSteps.zip', archive: true },
  { id: 'fantozzi-footsteps-pack', url: 'https://opengameart.org/sites/default/files/Fantozzi-footsteps.7z', file: 'Fantozzi-footsteps.7z', archive: true },
  { id: 'mud-sfx-pack', url: 'https://opengameart.org/sites/default/files/25-CC0-mud-sfx.zip', file: '25-CC0-mud-sfx.zip', archive: true },
  { id: 'rain-pack', url: 'https://opengameart.org/sites/default/files/Rain%20MP3.zip', file: 'Rain_MP3.zip', archive: true },
  { id: 'swishes-pack', url: 'https://opengameart.org/sites/default/files/swishes.zip', file: 'swishes.zip', archive: true },
  { id: 'interaction', url: 'https://opengameart.org/sites/default/files/interact_0.mp3', file: 'interact.mp3' },
];

async function downloadFile(url, destPath) {
  try {
    await fs.access(destPath);
    console.log(`  Already cached: ${path.basename(destPath)}`);
    return;
  } catch {}

  console.log(`  Downloading: ${url} -> ${path.basename(destPath)}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buffer);
  console.log(`  Saved ${buffer.length} bytes`);
}

async function unpackArchive(archivePath, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  console.log(`  Unpacking with 7z: ${path.basename(archivePath)} -> ${path.basename(outDir)}`);
  await execFileAsync('7z', ['x', '-y', `-o${outDir}`, archivePath]);
}

async function listFilesRecursive(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

(async () => {
  await fs.mkdir(STAGING_DIR, { recursive: true });
  await fs.mkdir(UNPACKED_DIR, { recursive: true });

  for (const src of SOURCES) {
    console.log(`\nProcessing source: ${src.id}`);
    const destPath = path.join(STAGING_DIR, src.file);
    await downloadFile(src.url, destPath);

    if (src.archive) {
      const outDir = path.join(UNPACKED_DIR, src.id);
      await unpackArchive(destPath, outDir);
      const files = await listFilesRecursive(outDir);
      console.log(`  Unpacked ${files.length} files:`);
      for (const f of files) {
        const stat = await fs.stat(f);
        console.log(`    - ${path.relative(outDir, f)} (${Math.round(stat.size / 1024)} KB)`);
      }
    }
  }

  console.log('\nAll sources staged successfully!');
})();
