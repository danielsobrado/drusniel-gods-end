import * as THREE from 'three';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';
import { createTerrainBakeFingerprint, TERRAIN_BAKE_VERSION } from './terrainBakeFingerprint.js';

const TYPES = Object.freeze({
  float32: Float32Array,
  uint32: Uint32Array,
  uint16: Uint16Array,
  uint8: Uint8Array,
});

function typedView(buffer, descriptor) {
  const Type = TYPES[descriptor?.type];
  if (!Type) throw new Error(`Unsupported baked terrain type: ${descriptor?.type}`);
  return new Type(buffer, descriptor.offset, descriptor.count);
}

export function validateBakedTerrainManifest(manifest, config) {
  if (!manifest || manifest.version !== TERRAIN_BAKE_VERSION) return false;
  if (manifest.fingerprint !== createTerrainBakeFingerprint(config)) return false;
  const resolution = Number(config.terrain?.heightResolution);
  return manifest.sampler?.resolution === resolution
    && manifest.geometry?.position?.count > 0
    && manifest.geometry?.index?.count > 0
    && manifest.sampler?.heights?.count === resolution * resolution
    && manifest.sampler?.normalMap?.count === resolution * resolution * 4;
}

async function decompressGzip(response) {
  // A static host that serves the pre-gzipped asset usually answers with
  // Content-Encoding: gzip, so the browser has already inflated the body.
  // Piping that through a second gzip decoder fails ("Failed to fetch"), which
  // silently dropped the bake and rebuilt the terrain at runtime. When the host
  // decoded it for us, take the bytes as they are; otherwise inflate ourselves.
  const encoding = (response.headers.get('content-encoding') ?? '').toLowerCase();
  if (encoding.includes('gzip')) return response.arrayBuffer();
  if (!response.body || typeof globalThis.DecompressionStream === 'undefined') return null;
  const stream = response.body.pipeThrough(new globalThis.DecompressionStream('gzip'));
  return new globalThis.Response(stream).arrayBuffer();
}

function setGeometryBounds(geometry, manifest) {
  const box = manifest.geometry.boundingBox;
  const sphere = manifest.geometry.boundingSphere;
  if (box?.min && box?.max) {
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3().fromArray(box.min),
      new THREE.Vector3().fromArray(box.max),
    );
  }
  if (sphere?.center && Number.isFinite(sphere.radius)) {
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3().fromArray(sphere.center),
      sphere.radius,
    );
  }
}

export async function loadBakedLandscapePackage(config, signal) {
  const settings = config.terrain?.expansion?.baked;
  if (!settings?.enabled || !settings.manifest
    || typeof globalThis.DecompressionStream === 'undefined'
    || typeof globalThis.Response === 'undefined') return null;

  try {
    signal?.throwIfAborted();
    const manifestResponse = await fetch(assetUrl(settings.manifest), {
      cache: 'no-cache',
      signal,
    });
    if (!manifestResponse.ok) throw new Error(`manifest status ${manifestResponse.status}`);
    const manifest = await manifestResponse.json();
    if (!validateBakedTerrainManifest(manifest, config)) {
      logger.warn('Baked terrain manifest is stale; using runtime terrain generation.');
      return null;
    }

    const dataPath = manifest.data ?? settings.data;
    if (!dataPath) throw new Error('baked terrain data path is missing');
    const dataUrl = new URL(assetUrl(dataPath));
    dataUrl.searchParams.set(
      'v',
      `${manifest.fingerprint}-${String(manifest.sourceSha256 ?? '').slice(0, 12)}`,
    );
    const dataResponse = await fetch(dataUrl, { cache: 'force-cache', signal });
    if (!dataResponse.ok) throw new Error(`data status ${dataResponse.status}`);
    const buffer = await decompressGzip(dataResponse);
    if (!buffer) return null;
    if (buffer.byteLength !== manifest.uncompressedBytes) {
      throw new Error(`baked terrain byte length ${buffer.byteLength} != ${manifest.uncompressedBytes}`);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(typedView(buffer, manifest.geometry.position), 3),
    );
    geometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(typedView(buffer, manifest.geometry.normal), 3),
    );
    geometry.setAttribute(
      'uv',
      new THREE.BufferAttribute(typedView(buffer, manifest.geometry.uv), 2),
    );
    geometry.setIndex(new THREE.BufferAttribute(typedView(buffer, manifest.geometry.index), 1));
    setGeometryBounds(geometry, manifest);

    return {
      geometry,
      sampler: {
        resolution: manifest.sampler.resolution,
        bounds: manifest.sampler.bounds,
        heights: typedView(buffer, manifest.sampler.heights),
        normalData: typedView(buffer, manifest.sampler.normalMap),
      },
      manifest,
    };
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
    logger.warn('Baked terrain package failed; using runtime terrain generation.', error);
    return null;
  }
}
