import { getSceneGraphVersion } from '../core/matrixUpdateCache.js';

// Planar reflection captures hide every object flagged excludeFromReflection
// and pause shadow-map updates. Both sets only change when the scene graph
// changes, so the traverse is cached per scene against the graph version. All
// excludeFromReflection flags are set before the object is added to the scene.
// Without the Object3D patch the version is -1 and every call re-traverses.
const reflectionMaskCache = new WeakMap();
const maskHidden = [];
const maskShadowAutoUpdate = [];
let cacheEnabled = true;

export function setReflectionMaskCacheEnabled(enabled) {
  cacheEnabled = Boolean(enabled);
}

export function collectReflectionMask(scene) {
  const version = cacheEnabled ? getSceneGraphVersion() : -1;
  let cache = reflectionMaskCache.get(scene);
  if (cache && version >= 0 && cache.version === version) return cache;
  if (!cache) {
    cache = { version, excluded: [], shadows: [] };
    reflectionMaskCache.set(scene, cache);
  }
  cache.version = version;
  cache.excluded.length = 0;
  cache.shadows.length = 0;
  scene.traverse((object) => {
    if (object.userData.excludeFromReflection) cache.excluded.push(object);
    if (object.isLight && object.shadow) cache.shadows.push(object.shadow);
  });
  return cache;
}

export function withReflectionMask(scene, callback) {
  const { excluded, shadows } = collectReflectionMask(scene);
  for (const object of excluded) {
    if (!object.visible) continue;
    maskHidden.push(object);
    object.visible = false;
  }
  for (const shadow of shadows) {
    maskShadowAutoUpdate.push(shadow.autoUpdate);
    shadow.autoUpdate = false;
  }
  try {
    return callback();
  } finally {
    for (const object of maskHidden) object.visible = true;
    for (let index = 0; index < shadows.length; index += 1) shadows[index].autoUpdate = maskShadowAutoUpdate[index];
    maskHidden.length = 0;
    maskShadowAutoUpdate.length = 0;
  }
}
