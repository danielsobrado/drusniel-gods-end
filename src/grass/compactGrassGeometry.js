import { StorageInstancedBufferAttribute } from 'three/webgpu';

const INSTANCE_ATTRIBUTES = ['instancePosition', 'instanceRotation', 'instanceData'];

// Remove only stems already hidden by the terrain/path mask. Preserve their
// original instanceData.y identities for distance transitions.
export function compactGrassGeometry(source, centerX, centerZ, containsGrass, target = null) {
  const position = source.getAttribute('instancePosition');
  // Reserve the source capacity once. Moving a tile must not destroy and
  // recreate renderer resources as its masked population grows and shrinks.
  const geometry = target ?? source.clone();
  if (!target && position.itemSize === 3) {
    // WGSL storage vec3s have a vec4 stride. Allocate that layout before the
    // first upload so WebGPU never replaces/re-pads a recycled position array.
    geometry.setAttribute('instancePosition', new StorageInstancedBufferAttribute(
      new Float32Array(position.count * 4), 4,
    ));
  }
  const inputs = INSTANCE_ATTRIBUTES.map((name) => source.getAttribute(name));
  const outputs = INSTANCE_ATTRIBUTES.map((name) => geometry.getAttribute(name));
  let count = 0;
  for (let i = 0; i < source.instanceCount; i++) {
    if (!containsGrass(centerX + position.getX(i), centerZ + position.getZ(i))) continue;
    for (let attributeIndex = 0; attributeIndex < inputs.length; attributeIndex++) {
      const input = inputs[attributeIndex];
      const attribute = outputs[attributeIndex];
      const output = attribute.array;
      const from = i * input.itemSize;
      const to = count * attribute.itemSize;
      for (let component = 0; component < input.itemSize; component++) {
        output[to + component] = input.array[from + component];
      }
    }
    count++;
  }
  for (const attribute of outputs) {
    // Leave StaticDrawUsage: Three's WebGPU backend uploads DynamicDrawUsage
    // every frame, even when its version has not changed.
    attribute.clearUpdateRanges();
    if (count > 0) {
      attribute.addUpdateRange(0, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }
  geometry.instanceCount = count;
  geometry.userData.instanceCount = count;
  return geometry;
}
