import { materialColor } from 'three/tsl';

// r180's material observer skips unchanged objects after the first draw using a
// shared material. Scene fog-node uniforms aren't part of that comparison, so
// other rocks/fences can retain the previous weather's fog. An explicit color
// node opts these materials into node updates without changing their shading.
export function prepareAtmosphereMaterials(root) {
  const prepared = new Set();
  root?.traverse(object => {
    if (!object.isMesh) return;
    const prepare = material => {
      if (!material?.color || material.fog === false || prepared.has(material)) return;
      if (Object.values(material).some(value => value?.isNode)) return;
      // The WebGPU material adapter copies this node onto its node material.
      // Keep the source identity so tree LOD/weather controllers still update it.
      material.colorNode = materialColor;
      material.needsUpdate = true;
      prepared.add(material);
    };
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) prepare(material);
  });
  return () => {
    for (const material of prepared) {
      if (material.colorNode === materialColor) {
        if (material.isNodeMaterial) material.colorNode = null;
        else delete material.colorNode;
        material.needsUpdate = true;
      }
    }
  };
}
