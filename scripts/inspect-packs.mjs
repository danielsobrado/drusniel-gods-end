// scripts/inspect-packs.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

async function probe(file) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration,bit_rate:stream=channels,sample_rate',
      '-of', 'json',
      file
    ]);
    const info = JSON.parse(stdout);
    return {
      name: path.basename(file),
      duration: Number(info.format?.duration || 0).toFixed(2),
      channels: info.streams?.[0]?.channels || 1,
      sampleRate: info.streams?.[0]?.sample_rate || '',
    };
  } catch (err) {
    return { name: path.basename(file), error: err.message };
  }
}

(async () => {
  const packs = [
    '.cache/audio-sources/unpacked/different-steps-pack',
    '.cache/audio-sources/unpacked/fantozzi-footsteps-pack/Fantozzi-footsteps/ogg',
    '.cache/audio-sources/unpacked/water-splashes-pack/ezwa-water_splash',
    '.cache/audio-sources/unpacked/swishes-pack/swishes',
    '.cache/audio-sources/unpacked/mud-sfx-pack',
  ];

  for (const pack of packs) {
    console.log(`\n=== ${path.basename(pack)} ===`);
    try {
      const files = (await fs.readdir(pack)).filter(f => /\.(ogg|wav|mp3|flac)$/i.test(f));
      for (const f of files) {
        const p = await probe(path.join(pack, f));
        console.log(`  ${p.name.padEnd(25)} ${p.duration}s  ch:${p.channels}  ${p.sampleRate}Hz`);
      }
    } catch (e) {
      console.log('Error:', e.message);
    }
  }
})();
