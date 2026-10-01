/**
 * Moves every texture image embedded in more than one GLB (or twice in one)
 * out to a single shared file, and points each GLB's image at it by relative
 * URI. The jungle plants, fantasy trees, meadow trees and rock packs embed the
 * same atlases and barks many times over; shared, each is downloaded once and
 * then served from the HTTP cache (the shared names carry a content hash, so
 * public/_headers marks them immutable).
 *
 * Idempotent: rerun after regenerating any GLB (assets:fantasy,
 * assets:split-terrain, the coastal-jungle sync) and it shares whatever was
 * embedded again. Geometry buffer views are copied byte for byte (Draco and
 * meshopt data stay intact); only image views are dropped and the rest
 * renumbered.
 *
 * Usage: node scripts/share-glb-textures.mjs [--check]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGlb, writeGlb } from './glb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const SHARED_TEXTURE_DIRECTORY = 'Assets/textures/shared';
// Scratch output and the dev-only original village (vite.config.js) are left alone.
const SKIP = [/^tmp\//, /^Assets\/terrain\/structures\/medieval\//];
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/ktx2': 'ktx2' };
const checkOnly = process.argv.includes('--check');

function walk(directory, out = []) {
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.glb')) out.push(full);
  }
  return out;
}

const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
const slug = (name) => (name ?? 'texture').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'texture';

function viewBytes(json, bin, index) {
  const view = json.bufferViews[index];
  if ((view.buffer ?? 0) !== 0 || view.extensions?.EXT_meshopt_compression) throw new Error(`image buffer view ${index} is not plain BIN data`);
  return bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}

// Every `bufferView` index anywhere in the JSON (accessors, images,
// KHR_draco_mesh_compression, ...), remapped; `null` marks a dropped view.
function remapBufferViews(value, map) {
  if (Array.isArray(value)) { for (const item of value) remapBufferViews(item, map); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'bufferView' && Number.isInteger(child)) {
      if (map[child] === null) throw new Error(`buffer view ${child} is still referenced after it was dropped`);
      value[key] = map[child];
    } else remapBufferViews(child, map);
  }
}

// Where a view's bytes live: EXT_meshopt_compression keeps the compressed
// data at the extension's own range (the view's own range then points into a
// data-less fallback buffer). Only ranges in buffer 0, the GLB's BIN chunk,
// are stored in the file.
function storedRange(view) {
  const meshopt = view.extensions?.EXT_meshopt_compression;
  return meshopt ?? view;
}

// Drops the given buffer views and repacks the BIN chunk, 16-byte aligned.
function dropViews(json, bin, dropped) {
  const map = [];
  const views = [];
  const chunks = [];
  let offset = 0;
  json.bufferViews.forEach((view, index) => {
    if (dropped.has(index)) { map.push(null); return; }
    const copy = structuredClone(view);
    const range = storedRange(copy);
    if ((range.buffer ?? 0) === 0) {
      const start = range.byteOffset ?? 0;
      const bytes = bin.subarray(start, start + range.byteLength);
      const pad = (16 - (offset % 16)) % 16;
      if (pad) chunks.push(Buffer.alloc(pad));
      offset += pad;
      range.byteOffset = offset;
      chunks.push(bytes);
      offset += bytes.length;
    }
    views.push(copy);
    map.push(views.length - 1);
  });
  json.bufferViews = views;
  for (const key of Object.keys(json)) if (key !== 'bufferViews') remapBufferViews(json[key], map);
  const packed = Buffer.concat(chunks);
  if (json.buffers?.[0]) json.buffers[0].byteLength = packed.length;
  return packed;
}

const files = walk(PUBLIC)
  .map((file) => ({ file, relative: path.relative(PUBLIC, file).replaceAll('\\', '/') }))
  .filter(({ relative }) => !SKIP.some((pattern) => pattern.test(relative)));

// Pass 1: count every embedded image by content.
const glbs = [];
const uses = new Map();
for (const entry of files) {
  const { json, bin } = parseGlb(readFileSync(entry.file));
  const embedded = [];
  (json.images ?? []).forEach((image, index) => {
    if (!Number.isInteger(image.bufferView)) return;
    const hash = hashOf(viewBytes(json, bin, image.bufferView));
    embedded.push({ index, hash });
    const use = uses.get(hash) ?? { count: 0, name: image.name, mimeType: image.mimeType, bytes: viewBytes(json, bin, image.bufferView) };
    use.count += 1;
    uses.set(hash, use);
  });
  glbs.push({ ...entry, json, bin, embedded });
}

// Pass 2: write each shared image once and rewrite the GLBs that embed it.
const sharedDirectory = path.join(PUBLIC, SHARED_TEXTURE_DIRECTORY);
let changedFiles = 0, savedBytes = 0, sharedFiles = 0;
const written = new Set();
for (const glb of glbs) {
  const shared = glb.embedded.filter(({ hash }) => uses.get(hash).count > 1);
  if (!shared.length) continue;
  const before = readFileSync(glb.file).length;
  const dropped = new Set();
  for (const { index, hash } of shared) {
    const use = uses.get(hash);
    const extension = EXTENSIONS[use.mimeType];
    if (!extension) throw new Error(`${glb.relative}: image ${index} has unsupported type ${use.mimeType}`);
    const name = `${slug(use.name)}-${hash.slice(0, 12)}.${extension}`;
    if (!written.has(name)) {
      written.add(name);
      sharedFiles += 1;
      if (!checkOnly) {
        mkdirSync(sharedDirectory, { recursive: true });
        writeFileSync(path.join(sharedDirectory, name), use.bytes);
      }
    }
    const image = glb.json.images[index];
    dropped.add(image.bufferView);
    delete image.bufferView;
    image.uri = path.posix.relative(path.posix.dirname(glb.relative), `${SHARED_TEXTURE_DIRECTORY}/${name}`);
  }
  // A view could in principle back two images; keep any still referenced.
  for (const image of glb.json.images) if (Number.isInteger(image.bufferView)) dropped.delete(image.bufferView);
  const bin = dropViews(glb.json, glb.bin, dropped);
  const output = writeGlb(glb.json, bin);
  savedBytes += before - output.length;
  changedFiles += 1;
  if (!checkOnly) writeFileSync(glb.file, output);
  console.log(`${glb.relative}: ${shared.length} shared image${shared.length === 1 ? '' : 's'}, ${(before / 1e6).toFixed(2)} -> ${(output.length / 1e6).toFixed(2)} MB`);
}
const sharedBytes = [...uses.values()].filter((use) => use.count > 1).reduce((sum, use) => sum + use.bytes.length, 0);
console.log(`\n${changedFiles} GLBs ${checkOnly ? 'would change' : 'changed'}; ${sharedFiles} shared textures (${(sharedBytes / 1e6).toFixed(2)} MB) `
  + `replace ${((savedBytes) / 1e6).toFixed(2)} MB of embedded copies: ${((savedBytes - sharedBytes) / 1e6).toFixed(2)} MB less in total.`);
if (checkOnly && changedFiles) process.exitCode = 1;
