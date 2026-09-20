import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { assetUrl } from '../assets/assetUrl.js';
import { captureObjectResources } from '../utils/ResourceScope.js';
import { logger } from '../utils/logger.js';

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
export function coverageTexture(texture, name = 'Foliage atlas') {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.name = name;
  texture.needsUpdate = true;
  return texture;
}
export async function loadVegetationLodAssets(keys, config, signal) {
  const base = config.vegetationLod?.assetPath ?? 'Assets/terrain/vegetation-lods/';
  const resources = [], variants = new Map();
  const dispose = () => { for (const release of resources.splice(0)) release(); };
  const draco = new DRACOLoader().setDecoderPath(config.assets.dracoDecoderPath);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const bundles = new Map();
  try {
    const response = await fetch(assetUrl(`${base}manifest.json`), { signal });
    if (!response.ok) throw new Error(`Vegetation manifest: ${response.status}`);
    const manifest = await response.json();
    // Bound decode/image work: many variants share large source texture maps.
    const queue = [...new Set(keys)];
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
                if (!bundles.has(url)) bundles.set(url, loader.loadAsync(url).then(gltf => {
                  resources.push(captureObjectResources(gltf.scene)); return gltf;
                }));
                const gltf = await bundles.get(url);
                const root = gltf.scene.getObjectByName(node);
                if (!root) continue;
                const parts = primitiveParts(root); variant.levels[level] = parts;
                resources.push(() => parts.forEach(p => p.geometry.dispose()));
              }
            } catch (error) { logger.warn(`Vegetation mesh LOD unavailable: ${key}`, error); }
          })(),
          (async () => {
            if (!entry.capture) return;
            try {
              const texture = await new THREE.TextureLoader().loadAsync(assetUrl(base + entry.atlas));
              variant.atlas = coverageTexture(texture, key); resources.push(() => variant.atlas.dispose());
            } catch (error) { logger.warn(`Vegetation atlas unavailable: ${key}`, error); }
          })(),
        ]);
      }
    }));
    signal?.throwIfAborted();
    return { variants, dispose };
  } catch (error) { dispose(); throw error; }
  finally { draco.dispose(); }
}
