import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';
import { resolveTerrainSources } from '../src/world/loadTerrain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLB_MAGIC = 0x46546c67;
const SHARED_TEXTURE_DIRECTORY = 'Assets/textures/shared';
const JSON_CHUNK = 0x4e4f534a;

function readGlbJson(relativePath) {
  const data = readFileSync(path.join(ROOT, relativePath));
  assert.equal(data.readUInt32LE(0), GLB_MAGIC, `${relativePath} is not a GLB`);
  assert.equal(data.readUInt32LE(4), 2, `${relativePath} is not glTF 2.0`);

  let offset = 12;
  while (offset < data.length) {
    const length = data.readUInt32LE(offset);
    const type = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === JSON_CHUNK) return JSON.parse(data.subarray(start, start + length).toString('utf8'));
    offset = start + length;
  }
  throw new Error(`${relativePath} has no JSON chunk`);
}

// GLTFLoader runs every node name through PropertyBinding.sanitizeNodeName, so
// the authored `Landscape.046` is what config calls `Landscape046`.
function sanitizeNodeName(name) {
  return name.replace(/\s/g, '_').replace(/[\\[\]./:]/g, '');
}

async function loadParts() {
  const config = await loadMergedConfig();
  const sources = resolveTerrainSources(config.assets);
  assert.ok(sources.length > 1, 'expected terrain to be configured as multiple parts');

  const parts = sources.map((source) => {
    const json = readGlbJson(path.join('public', source.path));
    const names = new Set(json.nodes.map((node) => sanitizeNodeName(node.name ?? '')));
    return { ...source, json, names };
  });
  return { config, parts };
}

function findParts(parts, name) {
  return parts.filter((part) => part.names.has(sanitizeNodeName(name)));
}

test('every configured terrain part file is a loadable glTF 2.0 binary', async () => {
  const { parts } = await loadParts();
  for (const part of parts) {
    assert.ok(part.json.nodes?.length > 0, `${part.path} has no nodes`);
    assert.ok(part.json.scenes?.length === 1, `${part.path} must expose exactly one scene`);
    assert.ok(part.json.buffers?.length <= 1, `${part.path} must be self-contained`);
    for (const buffer of part.json.buffers ?? []) {
      assert.equal(buffer.uri, undefined, `${part.path} must not reference an external buffer`);
    }
    // Textures are embedded, except the ones several GLBs share, which live
    // once in the shared texture directory (scripts/share-glb-textures.mjs).
    for (const image of part.json.images ?? []) {
      if (image.uri === undefined) continue;
      const target = path.posix.join(path.posix.dirname(part.path), image.uri);
      assert.ok(target.startsWith(SHARED_TEXTURE_DIRECTORY + '/'), `${part.path} must embed ${image.uri} or share it`);
      assert.ok(existsSync(path.join(ROOT, 'public', target)), `${part.path} references a missing shared texture ${target}`);
    }
  }
});

test('every object the config looks up by name exists in exactly one part', async () => {
  const { config, parts } = await loadParts();

  const expected = [
    config.terrain.targetMeshName,
    ...(config.ground?.materialTargets ?? []),
    ...Object.values(config.zones ?? {}),
    ...(config.trees?.types ?? []).flatMap((type) => [type.high, type.low, type.leaves]),
    config.birds?.sourceName,
    config.water?.colliderName,
    ...(config.collisions?.trimeshObjects ?? []),
  ].filter((name) => typeof name === 'string');

  assert.ok(expected.length > 0);
  for (const name of expected) {
    const matches = findParts(parts, name);
    assert.equal(
      matches.length,
      1,
      `"${name}" resolved to ${matches.length} parts (${matches.map((part) => part.name).join(', ')})`,
    );
  }
});

test('the bird flight clip travels with the bird part', async () => {
  const { config, parts } = await loadParts();
  const birdPart = findParts(parts, config.birds.sourceName)[0];
  assert.ok(birdPart, 'bird source part not found');
  assert.ok(birdPart.json.animations?.length > 0, 'bird part carries no animation');

  // The clip must bind to nodes inside its own part, or the mixer has nothing
  // to drive once the parts are reassembled under the terrain root.
  for (const channel of birdPart.json.animations[0].channels) {
    assert.ok(
      channel.target.node < birdPart.json.nodes.length,
      'animation channel targets a node outside the part',
    );
  }

  const partsWithAnimations = parts.filter((part) => (part.json.animations?.length ?? 0) > 0);
  assert.deepEqual(
    partsWithAnimations.map((part) => part.name),
    [birdPart.name],
    'only the bird part should contribute animation clips',
  );
});
