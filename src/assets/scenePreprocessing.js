import * as THREE from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { assetUrl } from './assetUrl.js';
import { logger } from '../utils/logger.js';

// Mesh simplification for the houses and NPCs is baked at build time
// (scripts/bake-scene-preprocessing.mjs) by the same simplifier and settings the
// runtime fallback uses. The runtime then only swaps in the baked index
// buffers, and only for a primitive whose decoded geometry matches the one the
// bake saw; anything missing, stale or malformed runs the original
// simplification instead.

/** Bump when the stages the bake produces would change for the same input. */
export const SCENE_PREPROCESSING_VERSION = 1;

export const SCENE_PREPROCESSING_MANIFEST = 'Assets/generated/scene-preprocessing.json';

// Houses: a detail stage beyond DETAIL_DISTANCE and a coarser shadow stage.
export const STRUCTURE_STAGES = Object.freeze({
  detail: Object.freeze({ error: 0.001 }),
  shadow: Object.freeze({ error: 0.003 }),
});

// NPC distance LODs: the full model, then 30%, 12% and 4% of its triangles.
export const NPC_LOD_RATIOS = Object.freeze([1, 0.3, 0.12, 0.04]);

export function npcStageKey(ratio) {
  return `ratio:${ratio}`;
}

/** Everything that changes baked output, compared as one string. */
export function scenePreprocessingSettings() {
  return JSON.stringify({
    version: SCENE_PREPROCESSING_VERSION,
    structures: STRUCTURE_STAGES,
    npcRatios: NPC_LOD_RATIOS,
  });
}

// The geometry a stage is valid for: its layout and the exact index, position
// and UV values the simplifier reads. Two 32-bit hashes (FNV-1a and a
// multiply-rotate mix) of every value, as 16 hex digits.
function words(array) {
  if (array instanceof Float32Array) {
    return array.byteOffset % 4 === 0
      ? new Uint32Array(array.buffer, array.byteOffset, array.length)
      : new Uint32Array(Float32Array.from(array).buffer);
  }
  return array;
}

export function geometrySignature(geometry) {
  let a = 0x811c9dc5, b = 0x9747b28c;
  const mix = (value) => {
    const word = value >>> 0;
    a = Math.imul(a ^ word, 0x01000193);
    b = Math.imul(b ^ word, 0x5bd1e995);
    b = (b << 13) | (b >>> 19);
  };
  const text = (value) => { for (let i = 0; i < value.length; i += 1) mix(value.charCodeAt(i)); };
  const layout = Object.keys(geometry.attributes).sort().map((name) => {
    const attribute = geometry.attributes[name];
    return `${name}:${attribute.itemSize}:${attribute.normalized ? 1 : 0}:${attribute.count}:${attribute.isInterleavedBufferAttribute ? 'i' : 'a'}`;
  });
  text(`${layout.join('|')}#groups:${geometry.groups.length}#index:${geometry.index?.count ?? -1}`);
  for (const attribute of [geometry.index, geometry.attributes.position, geometry.attributes.uv]) {
    if (!attribute || attribute.isInterleavedBufferAttribute) { mix(0xffffffff); continue; }
    const values = words(attribute.array);
    for (let i = 0; i < values.length; i += 1) mix(values[i]);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/**
 * A stage that shares every vertex attribute of `geometry` and only replaces
 * its index -- what the runtime simplifier builds from its own result.
 */
export function stageFromIndices(geometry, indices) {
  const stage = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) stage.setAttribute(name, attribute);
  for (const [name, attributes] of Object.entries(geometry.morphAttributes)) stage.morphAttributes[name] = attributes;
  stage.morphTargetsRelative = geometry.morphTargetsRelative;
  stage.setIndex(new THREE.BufferAttribute(indices, 1));
  stage.boundingBox = geometry.boundingBox?.clone() ?? null;
  stage.boundingSphere = geometry.boundingSphere?.clone() ?? null;
  return stage;
}

function validRange(descriptor, byteLength) {
  return descriptor && Number.isInteger(descriptor.offset) && Number.isInteger(descriptor.bytes)
    && Number.isInteger(descriptor.count) && descriptor.offset >= 0 && descriptor.bytes > 0
    && descriptor.count > 0 && descriptor.count % 3 === 0
    && descriptor.offset + descriptor.bytes <= byteLength;
}

/** Checks a parsed manifest against the data it indexes; false when unusable. */
export function validateScenePreprocessing(manifest, byteLength) {
  if (!manifest || manifest.version !== SCENE_PREPROCESSING_VERSION) return false;
  if (manifest.settings !== scenePreprocessingSettings()) return false;
  if (manifest.dataBytes !== byteLength || typeof manifest.sources !== 'object') return false;
  for (const source of Object.values(manifest.sources)) {
    if (!Array.isArray(source?.primitives)) return false;
    for (const primitive of source.primitives) {
      if (!Number.isInteger(primitive?.ordinal) || typeof primitive.signature !== 'string'
        || !Number.isInteger(primitive.vertexCount) || typeof primitive.stages !== 'object') return false;
      for (const stage of Object.values(primitive.stages)) {
        if (stage !== 'source' && !validRange(stage, byteLength)) return false;
      }
    }
  }
  return true;
}

/**
 * The baked stages. `stagesFor(sourcePath, ordinal, geometry)` returns
 * { [stageKey]: indices | 'source' } for the `ordinal`th simplified primitive,
 * or null when the bake does not describe this exact geometry.
 */
export class BakedScenePreprocessing {
  constructor(manifest, buffer) {
    this.manifest = manifest;
    this.buffer = buffer;
  }

  stagesFor(sourcePath, ordinal, geometry) {
    const source = this.manifest.sources[sourcePath];
    const primitive = source?.primitives.find((entry) => entry.ordinal === ordinal);
    const vertexCount = geometry.attributes.position?.count;
    if (!primitive || primitive.vertexCount !== vertexCount) return null;
    if (primitive.signature !== geometrySignature(geometry)) return null;
    const stages = {};
    for (const [key, descriptor] of Object.entries(primitive.stages)) {
      if (descriptor === 'source') { stages[key] = 'source'; continue; }
      const indices = new Uint32Array(descriptor.count);
      try {
        MeshoptDecoder.decodeIndexSequence(new Uint8Array(indices.buffer), descriptor.count, 4,
          new Uint8Array(this.buffer, descriptor.offset, descriptor.bytes));
      } catch {
        return null;
      }
      for (let i = 0; i < indices.length; i += 1) if (indices[i] >= vertexCount) return null;
      stages[key] = indices;
    }
    return stages;
  }
}

// The runtime simplifier (meshoptimizer's WASM) is fetched only when some
// primitive has no valid bake, so it stays out of the entry bundle.
let simplifier = null;
export function loadMeshSimplifier() {
  simplifier ??= import('../rendering/meshSimplify.js').then(async (module) => {
    await module.meshSimplifierReady;
    return module;
  });
  return simplifier;
}

/**
 * Stages for each geometry of one template: baked where the bake matches,
 * otherwise simplified now. `requests` is [[stageKey, simplifyOptions], ...];
 * returns one { [stageKey]: geometry } per entry of `geometries`, where the
 * geometry itself stands for a stage that saves nothing.
 */
export async function resolveStages(preprocessing, sourcePath, geometries, requests) {
  const baked = geometries.map((geometry, ordinal) => {
    const stages = preprocessing?.stagesFor(sourcePath, ordinal, geometry) ?? null;
    return stages && requests.every(([key]) => stages[key]) ? stages : null;
  });
  const runtime = baked.some((stages) => !stages) ? await loadMeshSimplifier() : null;
  return geometries.map((geometry, index) => Object.fromEntries(requests.map(([key, options]) => {
    const stage = baked[index]?.[key];
    if (stage === 'source') return [key, geometry];
    if (stage) return [key, stageFromIndices(geometry, stage)];
    return [key, runtime.simplifiedStage(geometry, options)];
  })));
}

// The data is served pre-gzipped. A host that answers with Content-Encoding:
// gzip has already inflated it, and inflating twice fails (as it did for the
// baked terrain, see BakedLandscape.js); otherwise inflate it here.
async function inflate(response) {
  const encoding = (response.headers.get('content-encoding') ?? '').toLowerCase();
  if (encoding.includes('gzip')) return response.arrayBuffer();
  if (!response.body || typeof globalThis.DecompressionStream === 'undefined') return null;
  const stream = response.body.pipeThrough(new globalThis.DecompressionStream('gzip'));
  return new globalThis.Response(stream).arrayBuffer();
}

/** Loads and validates the bake; null when unusable, rejects only on abort. */
export async function loadScenePreprocessing(signal) {
  try {
    const response = await fetch(assetUrl(SCENE_PREPROCESSING_MANIFEST), { cache: 'no-cache', signal });
    if (!response.ok) return null;
    const manifest = await response.json();
    if (manifest?.settings !== scenePreprocessingSettings() || !manifest.data) {
      logger.warn('Baked scene preprocessing is stale; simplifying at runtime.');
      return null;
    }
    const dataUrl = new URL(assetUrl(manifest.data));
    dataUrl.searchParams.set('v', manifest.dataSha256?.slice(0, 16) ?? '');
    const dataResponse = await fetch(dataUrl, { signal });
    if (!dataResponse.ok) return null;
    const [buffer] = await Promise.all([inflate(dataResponse), MeshoptDecoder.ready]);
    if (!buffer) return null;
    if (!validateScenePreprocessing(manifest, buffer.byteLength)) {
      logger.warn('Baked scene preprocessing is malformed; simplifying at runtime.');
      return null;
    }
    return new BakedScenePreprocessing(manifest, buffer);
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
    logger.warn('Baked scene preprocessing unavailable; simplifying at runtime.', error);
    return null;
  }
}
