import { InstancedBufferAttribute, StorageInstancedBufferAttribute } from 'three/webgpu';

// Three r186 reads the instance matrices of an InstancedMesh whose capacity
// fits a uniform buffer (up to 1024 on WebGPU) through a uniform buffer, and
// that binding reports itself changed on every draw: the whole buffer (16 KiB
// for a 256-tree batch, 51 KiB for understory) was written again for every
// draw in every pass, about 2 MiB a frame. A storage attribute is uploaded
// only when its version moves (needsUpdate) and honours update ranges, so
// matrices that did not change cost nothing.
//
// WebGL 2 cannot read storage buffers in the vertex stage, so it keeps the
// plain attribute. createWorld selects the kind once the backend is known.
let useStorage = false;

export function setStorageInstanceMatrices(enabled) {
  useStorage = Boolean(enabled);
}

export function createInstanceMatrixAttribute(capacity) {
  const array = new Float32Array(Math.max(1, capacity) * 16);
  return useStorage ? new StorageInstancedBufferAttribute(array, 16) : new InstancedBufferAttribute(array, 16);
}

// Moves a freshly built InstancedMesh onto the versioned attribute, keeping the
// identity matrices three initialised it with. Call before it is first drawn.
export function adoptInstanceMatrices(mesh) {
  if (!useStorage || mesh.instanceMatrix.isStorageInstancedBufferAttribute) return mesh;
  const source = mesh.instanceMatrix;
  const attribute = new StorageInstancedBufferAttribute(source.array, 16);
  attribute.usage = source.usage;
  mesh.instanceMatrix = attribute;
  return mesh;
}
