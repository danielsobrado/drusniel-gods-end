import { StorageInstancedBufferAttribute } from 'three/webgpu';

// Remove only stems already hidden by the terrain/path mask. Preserve their
// original instanceData.y identities for distance transitions.
export function compactGrassGeometry(source, centerX, centerZ, containsGrass) {
  const position = source.getAttribute('instancePosition');
  const kept = [];
  for (let i = 0; i < source.instanceCount; i++) {
    if (containsGrass(centerX + position.getX(i), centerZ + position.getZ(i))) kept.push(i);
  }
  const geometry = source.clone();
  for (const name of ['instancePosition', 'instanceRotation', 'instanceData']) {
    const attribute = source.getAttribute(name);
    const array = new Float32Array(kept.length * attribute.itemSize);
    kept.forEach((index, slot) => {
      array.set(attribute.array.subarray(index * attribute.itemSize, (index + 1) * attribute.itemSize), slot * attribute.itemSize);
    });
    geometry.setAttribute(name, new StorageInstancedBufferAttribute(array, attribute.itemSize));
  }
  geometry.instanceCount = kept.length;
  geometry.userData.instanceCount = kept.length;
  return geometry;
}
