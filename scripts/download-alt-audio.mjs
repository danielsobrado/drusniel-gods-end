import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import yaml from 'js-yaml';

const MANIFEST_PATH = path.resolve('scripts/audio-alt-sources.yaml');
const FORCE_FLAG = '--force';
const USER_AGENT = 'grass-test-audio-downloader/1.0';
const MP3_EXTENSION = '.mp3';
const ALT_SUFFIX = '_alt.mp3';
const MIN_MP3_BYTES = 256;
const ALLOWED_SOURCE_HOST = 'opengameart.org';
const MANUAL_SKIP_COMMANDS = new Set(['s', 'skip', 'n', 'no']);

function decodeHtmlAttribute(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&#38;', '&');
}

function isLikelyMp3(buffer) {
  if (buffer.length < MIN_MP3_BYTES) return false;
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3') return true;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

function validateManifest(manifest) {
  if (!manifest?.audioDirectory || !Array.isArray(manifest.sources)) {
    throw new Error('Audio manifest must define audioDirectory and sources.');
  }

  const targets = new Set();
  for (const source of manifest.sources) {
    if (!source?.id || !source.page || !source.file || source.license !== 'CC0') {
      throw new Error(`Invalid audio source entry: ${source?.id ?? '<unknown>'}`);
    }
    if (!Array.isArray(source.targets) || source.targets.length === 0) {
      throw new Error(`Audio source ${source.id} must define at least one target.`);
    }

    const sourceUrl = new URL(source.page);
    if (sourceUrl.protocol !== 'https:' || sourceUrl.hostname !== ALLOWED_SOURCE_HOST) {
      throw new Error(`Audio source ${source.id} must use ${ALLOWED_SOURCE_HOST}.`);
    }
    if (!source.file.toLowerCase().endsWith(MP3_EXTENSION)) {
      throw new Error(`Audio source ${source.id} must reference an MP3 file.`);
    }

    for (const target of source.targets) {
      if (path.basename(target) !== target || !target.endsWith(ALT_SUFFIX)) {
        throw new Error(`Invalid alternate audio target: ${target}`);
      }
      if (targets.has(target)) {
        throw new Error(`Duplicate alternate audio target: ${target}`);
      }
      targets.add(target);
    }
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return response.text();
}

function assertCc0License(source, html) {
  if (!/\bCC0\b/i.test(html)) {
    throw new Error(`CC0 license marker not found on source page for ${source.id}.`);
  }
}

function findDownloadUrl(source, html) {
  const links = html.matchAll(/href\s*=\s*["']([^"']+)["']/gi);
  for (const match of links) {
    const href = decodeHtmlAttribute(match[1]);
    let candidate;
    try {
      candidate = new URL(href, source.page);
    } catch {
      continue;
    }

    const encodedName = candidate.pathname.split('/').pop() ?? '';
    let fileName;
    try {
      fileName = decodeURIComponent(encodedName);
    } catch {
      fileName = encodedName;
    }
    if (fileName === source.file) return candidate;
  }

  throw new Error(`Could not locate ${source.file} on ${source.page}`);
}

async function downloadSource(source) {
  const html = await fetchText(source.page);
  assertCc0License(source, html);
  const downloadUrl = findDownloadUrl(source, html);

  const response = await fetch(downloadUrl, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while downloading ${source.file}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!isLikelyMp3(buffer)) {
    throw new Error(`Downloaded file is not a valid-looking MP3: ${source.file}`);
  }
  return buffer;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomically(filePath, buffer) {
  const temporaryPath = `${filePath}.${process.pid}.part`;
  await fs.writeFile(temporaryPath, buffer);
  try {
    await fs.rm(filePath, { force: true });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function manualFilePattern(sourceFile) {
  const extension = path.extname(sourceFile);
  const baseName = path.basename(sourceFile, extension);
  return new RegExp(`^${escapeRegExp(baseName)}(?: \\((\\d+)\\))?${escapeRegExp(extension)}$`, 'i');
}

async function findManualDownloads(audioDirectory, sourceFile) {
  const pattern = manualFilePattern(sourceFile);
  const entries = await fs.readdir(audioDirectory, { withFileTypes: true });
  const matches = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = pattern.exec(entry.name);
    if (!match) continue;
    matches.push({
      name: entry.name,
      path: path.join(audioDirectory, entry.name),
      order: match[1] ? Number(match[1]) : 0,
    });
  }

  return matches.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

async function readValidatedMp3(filePath) {
  const buffer = await fs.readFile(filePath);
  if (!isLikelyMp3(buffer)) {
    throw new Error(`Manual file is not a valid-looking MP3: ${path.basename(filePath)}`);
  }
  return buffer;
}

async function adoptManualDownloads(source, audioDirectory, pendingTargets) {
  const candidates = await findManualDownloads(audioDirectory, source.file);
  if (candidates.length === 0) return null;

  const buffers = [];
  for (const candidate of candidates) {
    buffers.push({ candidate, buffer: await readValidatedMp3(candidate.path) });
  }

  const usedCandidates = new Set();
  let firstBuffer = null;
  for (let index = 0; index < pendingTargets.length; index += 1) {
    const target = pendingTargets[index];
    const selected = buffers[Math.min(index, buffers.length - 1)];
    if (!firstBuffer) firstBuffer = selected.buffer;

    await writeAtomically(target.targetPath, selected.buffer);
    usedCandidates.add(selected.candidate.path);
    console.log(`adopt ${selected.candidate.name} -> ${target.target}`);
  }

  for (const candidatePath of usedCandidates) {
    await fs.rm(candidatePath, { force: true });
  }

  return firstBuffer;
}

function sourceCacheKey(source) {
  return `${source.page}\n${source.file}`;
}

function printManualInstructions(source, audioDirectory, pendingTargets, error) {
  const relativeDirectory = path.relative(process.cwd(), audioDirectory) || '.';
  console.error('');
  console.error(`Automatic download failed for ${source.id}: ${error.message}`);
  console.error('Manual download required:');
  console.error(`  Open: ${source.page}`);
  console.error(`  Download: ${source.file}`);
  console.error(`  Save into: ${relativeDirectory}`);
  console.error(`  Expected output: ${pendingTargets.map(({ target }) => target).join(', ')}`);
  console.error(`  Chrome-style duplicates such as "${path.basename(source.file, MP3_EXTENSION)} (1).mp3" are also detected.`);
}

async function waitForManualDownload(source, audioDirectory, pendingTargets, error) {
  printManualInstructions(source, audioDirectory, pendingTargets, error);

  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await readline.question('Press Enter after saving the file, or type "skip": '))
        .trim()
        .toLowerCase();
      if (MANUAL_SKIP_COMMANDS.has(answer)) return null;

      const buffer = await adoptManualDownloads(source, audioDirectory, pendingTargets);
      if (buffer) return buffer;

      console.error(`Still not found: ${source.file}`);
      console.error(`Place it in ${path.relative(process.cwd(), audioDirectory) || '.'} and try again.`);
    }
  } finally {
    readline.close();
  }
}

async function getPendingTargets(source, audioDirectory, force) {
  const pendingTargets = [];
  let skipped = 0;

  for (const target of source.targets) {
    const targetPath = path.join(audioDirectory, target);
    if (!force && await fileExists(targetPath)) {
      console.log(`skip  ${target}`);
      skipped += 1;
      continue;
    }
    pendingTargets.push({ target, targetPath });
  }

  return { pendingTargets, skipped };
}

async function writeTargets(pendingTargets, buffer) {
  for (const { target, targetPath } of pendingTargets) {
    await writeAtomically(targetPath, buffer);
    console.log(`write ${target}`);
  }
}

async function processSource(source, audioDirectory, force, sourceCache) {
  const { pendingTargets, skipped } = await getPendingTargets(source, audioDirectory, force);
  if (pendingTargets.length === 0) return { written: 0, skipped };

  const cacheKey = sourceCacheKey(source);
  const cachedBuffer = sourceCache.get(cacheKey);
  if (cachedBuffer) {
    await writeTargets(pendingTargets, cachedBuffer);
    return { written: pendingTargets.length, skipped };
  }

  const manualBuffer = await adoptManualDownloads(source, audioDirectory, pendingTargets);
  if (manualBuffer) {
    sourceCache.set(cacheKey, manualBuffer);
    return { written: pendingTargets.length, skipped };
  }

  console.log(`fetch ${source.id}: ${source.page}`);
  try {
    const buffer = await downloadSource(source);
    sourceCache.set(cacheKey, buffer);
    await writeTargets(pendingTargets, buffer);
    return { written: pendingTargets.length, skipped };
  } catch (error) {
    const lateManualBuffer = await adoptManualDownloads(source, audioDirectory, pendingTargets);
    if (lateManualBuffer) {
      sourceCache.set(cacheKey, lateManualBuffer);
      return { written: pendingTargets.length, skipped };
    }

    const promptedBuffer = await waitForManualDownload(
      source,
      audioDirectory,
      pendingTargets,
      error,
    );
    if (!promptedBuffer) throw error;

    sourceCache.set(cacheKey, promptedBuffer);
    return { written: pendingTargets.length, skipped };
  }
}

async function main() {
  const force = process.argv.includes(FORCE_FLAG);
  const manifest = yaml.load(await fs.readFile(MANIFEST_PATH, 'utf8'));
  validateManifest(manifest);

  const audioDirectory = path.resolve(manifest.audioDirectory);
  await fs.mkdir(audioDirectory, { recursive: true });

  let written = 0;
  let skipped = 0;
  const failures = [];
  const sourceCache = new Map();

  for (const source of manifest.sources) {
    try {
      const result = await processSource(source, audioDirectory, force, sourceCache);
      written += result.written;
      skipped += result.skipped;
    } catch (error) {
      failures.push({ id: source.id, error });
      console.error(`fail  ${source.id}: ${error.message}`);
    }
  }

  console.log(`Alternate audio complete: ${written} written, ${skipped} skipped, ${failures.length} failed.`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Failed to download alternate audio:', error);
  process.exitCode = 1;
});
