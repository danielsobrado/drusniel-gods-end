import * as THREE from 'three';
import { generateSurfaceData, SURFACE_NAMES } from './houseTextureData.js';

export { TEXTURE_METRES, SURFACE_NAMES } from './houseTextureData.js';

// Turns generated house surfaces into tiling, mipmapped DataTextures. The
// texels come from a small worker pool (the generators cost about half a
// second of CPU together, which would otherwise stall loading), or from the
// main thread where workers are unavailable (tests, old browsers).

const MAX_WORKERS = 4;

function finishTexture(texture) {
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function toTextures({ size, color, normal }) {
  const map = finishTexture(new THREE.DataTexture(color, size, size));
  map.colorSpace = THREE.SRGBColorSpace;
  return { map, normalMap: finishTexture(new THREE.DataTexture(normal, size, size)) };
}

function generateInWorkers(names, signal) {
  const count = Math.max(1, Math.min(MAX_WORKERS, names.length, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1));
  const queue = [...names];
  const results = new Map();
  const workers = [];
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      for (const worker of workers) worker.terminate();
      if (error) reject(error); else resolve(results);
    };
    signal?.addEventListener('abort', () => finish(signal.reason), { once: true });
    const next = (worker) => {
      const name = queue.shift();
      if (name) worker.postMessage({ name });
      else if (results.size === names.length) finish();
    };
    for (let i = 0; i < count; i += 1) {
      const worker = new Worker(new URL('./houseTexture.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        results.set(data.name, data);
        next(worker);
      };
      worker.onerror = (event) => finish(event.error ?? new Error(event.message || 'House texture worker failed'));
      workers.push(worker);
      next(worker);
    }
  });
}

/**
 * Generates every house surface and resolves to name -> { map, normalMap }.
 * Workers run the generators in parallel; any failure falls back to the main
 * thread so the village still gets its textures.
 */
export async function generateHouseSurfaces({ signal, useWorkers = typeof Worker !== 'undefined' } = {}) {
  let data = null;
  if (useWorkers) {
    try {
      data = await generateInWorkers(SURFACE_NAMES, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      data = null;
    }
  }
  const surfaces = new Map();
  for (const name of SURFACE_NAMES) {
    signal?.throwIfAborted();
    surfaces.set(name, toTextures(data?.get(name) ?? generateSurfaceData(name)));
  }
  return surfaces;
}
