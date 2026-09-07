// scripts/verify-sound-bank.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const BASE = path.resolve('public/Assets/Audio');

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...await listFiles(full));
    else if (e.name.endsWith('.mp3')) files.push(full);
  }
  return files;
}

(async () => {
  const subdirs = ['ambient', 'wildlife', 'footsteps', 'water', 'transitions'];
  let totalFiles = 0;
  let validFiles = 0;
  let totalBytes = 0;

  for (const sub of subdirs) {
    const dirPath = path.join(BASE, sub);
    const files = await listFiles(dirPath);
    console.log(`\nDirectory: ${sub}/ (${files.length} files)`);

    for (const file of files) {
      totalFiles++;
      const stat = await fs.stat(file);
      totalBytes += stat.size;

      try {
        const { stdout } = await execFileAsync('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=format_name,duration:stream=codec_name,channels,sample_rate,bit_rate',
          '-of', 'json',
          file
        ]);
        const info = JSON.parse(stdout);
        const format = info.format?.format_name;
        const codec = info.streams?.[0]?.codec_name;

        if (format.includes('mp3') && codec === 'mp3') {
          validFiles++;
          // Read first 3 bytes to verify ID3 or MPEG sync
          const buf = Buffer.alloc(3);
          const fd = await fs.open(file, 'r');
          await fd.read(buf, 0, 3, 0);
          await fd.close();
          const hasSync = (buf.toString('ascii') === 'ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
          if (!hasSync) {
            console.error(`  [WARN] ${path.basename(file)}: missing ID3/sync header`);
          }
        } else {
          console.error(`  [FAIL] ${path.basename(file)}: unexpected format ${format}/${codec}`);
        }
      } catch (err) {
        console.error(`  [ERR] ${path.basename(file)}: ${err.message}`);
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`Verification: ${validFiles} / ${totalFiles} valid MP3s`);
  console.log(`Total Bank Size: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`========================================`);

  if (validFiles !== totalFiles) process.exit(1);
})();
