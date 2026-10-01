import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { assetUrl } from '../assets/assetUrl.js';
import { captureObjectResources } from '../utils/ResourceScope.js';
import { logger } from '../utils/logger.js';
import { foliageMipmaps } from './alphaCoverage.js';
import { getVegetationKtx2Loader } from './VegetationKtx2Loader.js';
import { createLowTreeParts } from './LowTreeGeometry.js';
import {
  fallbackTreeImpostorTextureFromImage,
  isDetailedTreeImpostorQuality,
  resolveTreeImpostorSettings,
  treeImpostorPlaceholderTexture,
  updatePackedTreeImpostorTextureFromImage,
} from './TreeImpostorMaps.js';

const manifestCache = new Map();

function withAbort(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function vegetationManifest(url, signal) {
  if (!manifestCache.has(url)) {
    const pending = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`Vegetation manifest: ${response.status}`);
      return response.json();
    });
    manifestCache.set(url, pending);
    pending.catch(() => manifestCache.delete(url));
  }
  return withAbort(manifestCache.get(url), signal);
}

export function primitiveParts(root) {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert(), parts = [];
  root.traverse(object => {
    if (!object.isMesh) return;
    const geometry = object.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld));
    geometry.computeBoundingBox();
    parts.push({ geometry, material: object.material, name: object.name });
  });
  return parts;
}
export function vegetationAtlasPaths(entry, config, rendererAvailable = true) {
  const compressed = rendererAvailable && config.vegetationLod?.ktx2?.enabled
    ? entry?.atlasKtx2 ?? null
    : null;
  return {
    compressed,
    fallback: entry?.atlas ?? null,
  };
}

export function coverageTexture(texture, name = 'Foliage atlas', anisotropy = 4) {
  if (!texture?.isTexture) throw new TypeError(`${name} must be a THREE.Texture`);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const hasMipmaps = Array.isArray(texture.mipmaps) && texture.mipmaps.length > 0;
  texture.generateMipmaps = !texture.isCompressedTexture && !hasMipmaps;
  texture.anisotropy = Math.max(1, Number(anisotropy) || 1);
  texture.name = name;
  texture.needsUpdate = true;
  return texture;
}

export function coverageTextureFromImage(image, name = 'Foliage atlas', cutoff = 0.35, anisotropy = 4) {
  if (!image?.width || !image?.height) throw new TypeError(`${name} must have image dimensions`);
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2D canvas context unavailable for foliage atlas.');
  context.drawImage(image, 0, 0);

  const input = context.getImageData(0, 0, image.width, image.height).data;
  const data = new Uint8Array(input.length);
  const stride = image.width * 4;
  for (let y = 0; y < image.height; y += 1) {
    data.set(
      input.subarray(y * stride, (y + 1) * stride),
      (image.height - y - 1) * stride,
    );
  }

  const texture = new THREE.DataTexture(data, image.width, image.height);
  texture.mipmaps = foliageMipmaps(data, image.width, image.height, cutoff);
  texture.flipY = false;
  texture.generateMipmaps = false;
  return coverageTexture(texture, name, anisotropy);
}
// With a shared load context (`assets`) the parsed bundles belong to it and are
// shared with every other caller; without one this call loads and owns them.
export async function loadVegetationLodAssets(keys, config, signal, { renderer = null, assets = null } = {}) {
  const base = config.vegetationLod?.assetPath ?? 'Assets/terrain/vegetation-lods/';
  const resources = [], variants = new Map();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const release of resources.splice(0)) release();
  };
  const dracoPath = assets ? null : config.assets?.dracoDecoderPath;
  const draco = dracoPath ? new DRACOLoader().setDecoderPath(dracoPath) : null;
  const loader = assets ? null : new GLTFLoader();
  const textureLoader = new THREE.TextureLoader();
  if (draco) loader.setDRACOLoader(draco);
  let ktx2 = null;
  const bundles = new Map();
  const detailedTreeImpostors = isDetailedTreeImpostorQuality(config);
  const impostorSettings = resolveTreeImpostorSettings(config);
  try {
    signal?.throwIfAborted();
    const manifest = await vegetationManifest(assetUrl(`${base}manifest.json`), signal);
    signal?.throwIfAborted();
    const requestedKeys = [...new Set(keys)];
    const hasCompressedAtlas = requestedKeys.some((key) => manifest.variants[key]?.atlasKtx2);
    if (renderer && hasCompressedAtlas) {
      ktx2 = getVegetationKtx2Loader(renderer, config, signal);
    }

    // Bound decode/image work: many variants share large source texture maps.
    const queue = [...requestedKeys];
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (queue.length && !signal?.aborted) {
        const key = queue.shift(), entry = manifest.variants[key];
        if (!entry) continue;
        const variant = { entry, levels: [null, null, null, null] }; variants.set(key, variant);
        await Promise.all([
          (async () => {
            if (!entry.mesh) return;
            try {
              // Trees carry one mesh derivative; the impostor takes the stages below it.
              for (const [level, field] of [[1, 'medium'], [2, 'lowMesh']]) {
                const definition = /^tree\d+$/.test(key) ? config.trees?.types?.[Number(key.slice(4)) - 1] : null;
                const override = definition?.[level === 1 ? 'mediumMesh' : 'lowMesh'];
                const node = override?.node ?? entry[field];
                if (!node) continue;
                const file = override?.asset ?? entry.mesh;
                const url = override?.asset ? assetUrl(file) : assetUrl(base + file);
                if (!bundles.has(url)) {
                  bundles.set(url, assets
                    ? assets.loadTemplate(url, { signal })
                    : loader.loadAsync(url).then(gltf => {
                      resources.push(captureObjectResources(gltf.scene)); return gltf;
                    }));
                }
                const gltf = await bundles.get(url);
                const root = gltf.scene.getObjectByName(node);
                if (!root) continue;
                const parts = primitiveParts(root); variant.levels[level] = parts;
                resources.push(() => parts.forEach(p => p.geometry.dispose()));
              }
              if (entry.tree && variant.levels[1]?.length && !variant.levels[2]?.length) {
                const derived = createLowTreeParts(variant.levels[1], config.trees?.lod?.low);
                variant.levels[2] = derived.parts;
                resources.push(derived.dispose);
              }
            } catch (error) { logger.warn(`Vegetation mesh LOD unavailable: ${key}`, error); }
          })(),
          (async () => {
            if (!entry.atlas && !entry.atlasKtx2) return;
            let texture = null, fallbackTexture = null;
            const atlas = vegetationAtlasPaths(entry, config, Boolean(ktx2));
            const atlasAnisotropy = entry.tree ? impostorSettings.anisotropy : 4;
            const loadFallback = async () => {
              if (!atlas.fallback) return null;
              fallbackTexture ??= await textureLoader.loadAsync(assetUrl(base + atlas.fallback));
              signal?.throwIfAborted();
              return fallbackTexture;
            };
            try {
              if (ktx2 && atlas.compressed) {
                try {
                  texture = await ktx2.loadAsync(assetUrl(base + atlas.compressed));
                } catch (error) {
                  signal?.throwIfAborted();
                  logger.warn(`KTX2 vegetation atlas unavailable; using WebP: ${key}`, error);
                }
              }
              signal?.throwIfAborted();
              if (!texture && atlas.fallback) {
                try {
                  const fallback = await loadFallback();
                  texture = coverageTextureFromImage(
                    fallback.image,
                    key,
                    Number(entry.alphaCutoff) || 0.35,
                    atlasAnisotropy,
                  );
                } catch (error) {
                  signal?.throwIfAborted();
                  logger.warn(`Vegetation atlas unavailable: ${key}`, error);
                }
              }
              if (!texture) return;
              variant.atlas = texture.isDataTexture ? texture : coverageTexture(texture, key, atlasAnisotropy);
              resources.push(() => variant.atlas.dispose());

              if (!entry.tree || !entry.capture) return;
              try {
                if (entry.normalMask) {
                  variant.normalMask = treeImpostorPlaceholderTexture(
                    impostorSettings,
                    `${key}:normal-mask`,
                  );
                  resources.push(() => variant.normalMask.dispose());
                  let normalReady = false;
                  let normalPromise = null;
                  variant.normalMaskReady = () => normalReady;
                  variant.ensureNormalMask = () => {
                    if (normalReady) return Promise.resolve(variant.normalMask);
                    if (normalPromise) return normalPromise;
                    normalPromise = (async () => {
                      if (disposed) throw new Error(`Vegetation assets disposed before loading ${key} normals`);
                      const source = await textureLoader.loadAsync(assetUrl(base + entry.normalMask));
                      try {
                        if (disposed) throw new Error(`Vegetation assets disposed while loading ${key} normals`);
                        updatePackedTreeImpostorTextureFromImage(
                          variant.normalMask,
                          source.image,
                          impostorSettings,
                          `${key}:normal-mask`,
                        );
                        normalReady = true;
                        return variant.normalMask;
                      } finally {
                        source.dispose();
                      }
                    })().catch((error) => {
                      normalPromise = null;
                      throw error;
                    });
                    return normalPromise;
                  };
                } else if (detailedTreeImpostors && atlas.fallback) {
                  const fallback = await loadFallback();
                  variant.normalMask = fallbackTreeImpostorTextureFromImage(
                    fallback.image,
                    entry.capture,
                    impostorSettings,
                    `${key}:generated-normal-mask`,
                  );
                  variant.normalMaskReady = () => true;
                  resources.push(() => variant.normalMask.dispose());
                }
              } catch (error) {
                signal?.throwIfAborted();
                logger.warn(`Tree impostor normal/mask unavailable; using analytic fallback: ${key}`, error);
              }
            } finally {
              fallbackTexture?.dispose();
            }
          })(),
        ]);
      }
    }));
    signal?.throwIfAborted();
    return { variants, dispose };
  } catch (error) { dispose(); throw error; }
  finally {
    draco?.dispose();
  }
}
