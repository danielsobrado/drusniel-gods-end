import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as THREE from 'three';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco from 'draco3dgltf';
import { loadMergedConfig } from './mergedConfig.mjs';
import { TerrainSampler } from '../src/world/TerrainSampler.js';
import { expandLandscape } from '../src/world/ExpandedLandscape.js';
import { createTerrainBakeFingerprint, TERRAIN_BAKE_VERSION } from '../src/world/terrainBakeFingerprint.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function publicPath(assetPath) {
  return path.join(ROOT, 'public', assetPath.replace(/^\/+/, ''));
}

function align4(value) {
  return (value + 3) & ~3;
}

function arrayType(array) {
  if (array instanceof Float32Array) return 'float32';
  if (array instanceof Uint32Array) return 'uint32';
  if (array instanceof Uint16Array) return 'uint16';
  if (array instanceof Uint8Array) return 'uint8';
  throw new Error(`Unsupported baked terrain array: ${array.constructor.name}`);
}

function packArrays(entries) {
  const layout = {};
  const chunks = [];
  let offset = 0;
  for (const [name, array] of entries) {
    const aligned = align4(offset);
    if (aligned > offset) chunks.push(Buffer.alloc(aligned - offset));
    offset = aligned;
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    layout[name] = {
      offset,
      count: array.length,
      byteLength: array.byteLength,
      type: arrayType(array),
    };
    chunks.push(bytes);
    offset += array.byteLength;
  }
  return { buffer: Buffer.concat(chunks), layout };
}

function findSourceNode(document, name) {
  const nodes = document.getRoot().listNodes();
  return nodes.find(node => node.getName() === name)
    ?? nodes.find(node => node.getMesh()?.getName() === name)
    ?? null;
}

async function main() {
  const config = await loadMergedConfig();
  const settings = config.terrain?.expansion?.baked;
  if (!config.terrain?.expansion?.enabled || !settings?.enabled) {
    console.log('Expanded terrain bake disabled.');
    return;
  }
  if (!settings.source || !settings.sourceNodeName || !settings.manifest || !settings.data) {
    throw new Error('terrain.expansion.baked requires source, sourceNodeName, manifest and data');
  }

  const sourcePath = publicPath(settings.source);
  const sourceBytes = await readFile(sourcePath);
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const decoder = await draco.createDecoderModule();
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.decoder': decoder });
  const document = await io.read(sourcePath);
  const node = findSourceNode(document, settings.sourceNodeName);
  if (!node?.getMesh()) throw new Error(`Terrain source node "${settings.sourceNodeName}" not found.`);
  const primitive = node.getMesh().listPrimitives()[0];

  const sourceGeometry = new THREE.BufferGeometry();
  sourceGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(primitive.getAttribute('POSITION').getArray().slice(), 3),
  );
  sourceGeometry.setIndex(
    new THREE.BufferAttribute(primitive.getIndices().getArray().slice(), 1),
  );

  const mesh = new THREE.Mesh(sourceGeometry);
  mesh.name = config.terrain.targetMeshName;
  mesh.applyMatrix4(new THREE.Matrix4().fromArray(node.getWorldMatrix()));
  const coarseConfig = {
    ...config,
    terrain: { ...config.terrain, heightResolution: 384 },
  };
  const original = new TerrainSampler(mesh, coarseConfig);
  await original.buildHeightOnly();
  const expansion = expandLandscape(mesh, original, config);
  if (!expansion) throw new Error('Expanded terrain generation returned no result.');

  const sampler = new TerrainSampler(mesh, config);
  await sampler.build();
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position').array;
  const normal = geometry.getAttribute('normal').array;
  const uv = geometry.getAttribute('uv').array;
  const index = geometry.index.array;
  const heights = sampler.heights;
  const normalMap = sampler.normalTexture.image.data;

  const packed = packArrays([
    ['position', position],
    ['normal', normal],
    ['uv', uv],
    ['index', index],
    ['heights', heights],
    ['normalMap', normalMap],
  ]);
  const compressed = gzipSync(packed.buffer, { level: 9 });
  const geometryBox = geometry.boundingBox;
  const geometrySphere = geometry.boundingSphere;
  const manifest = {
    version: TERRAIN_BAKE_VERSION,
    fingerprint: createTerrainBakeFingerprint(config),
    sourceSha256,
    data: settings.data,
    uncompressedBytes: packed.buffer.length,
    compressedBytes: compressed.length,
    geometry: {
      position: packed.layout.position,
      normal: packed.layout.normal,
      uv: packed.layout.uv,
      index: packed.layout.index,
      boundingBox: {
        min: geometryBox.min.toArray(),
        max: geometryBox.max.toArray(),
      },
      boundingSphere: {
        center: geometrySphere.center.toArray(),
        radius: geometrySphere.radius,
      },
    },
    sampler: {
      resolution: sampler.resolution,
      bounds: {
        min: sampler.bounds.min.toArray(),
        max: sampler.bounds.max.toArray(),
      },
      heights: packed.layout.heights,
      normalMap: packed.layout.normalMap,
    },
    stats: {
      vertices: position.length / 3,
      triangles: index.length / 3,
    },
  };

  const dataPath = publicPath(settings.data);
  const manifestPath = publicPath(settings.manifest);
  await mkdir(path.dirname(dataPath), { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await Promise.all([
    writeFile(dataPath, compressed),
    writeFile(manifestPath, JSON.stringify(manifest) + '\n'),
  ]);

  const ratio = compressed.length / packed.buffer.length;
  console.log(
    `Baked expanded terrain: ${manifest.stats.vertices} vertices, ${manifest.stats.triangles} triangles, `
    + `${(packed.buffer.length / 1048576).toFixed(2)} MiB -> `
    + `${(compressed.length / 1048576).toFixed(2)} MiB (${(ratio * 100).toFixed(1)}%)`,
  );

  sampler.texture?.dispose();
  sampler.normalTexture?.dispose();
  expansion.dispose();
  sourceGeometry.dispose();
  mesh.material.dispose();
}

await main();
