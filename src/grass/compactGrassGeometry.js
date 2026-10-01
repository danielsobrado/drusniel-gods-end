import { StorageInstancedBufferAttribute } from 'three/webgpu';

const INSTANCE_ATTRIBUTES = ['instancePosition', 'instanceRotation', 'instanceData'];
// Scratch geometries per source LOD. A recycled tile compacts into scratch and
// then copies the result into its cached geometry, so without a pool every
// tile move cloned the whole LOD (topology and instance arrays) only to
// dispose it again. Scratch is never drawn; its capacity matches its source.
const SCRATCH_POOL_LIMIT = 4;
const scratchPools = new WeakMap();

// A clean scratch target for compactGrassGeometry(source, ..., target, { resume: true }).
export function acquireCompactionScratch(source) {
  const geometry = scratchPools.get(source)?.pop();
  if (!geometry) return null;
  geometry.userData = { ...source.userData, compactCursor: 0, compactCount: 0, compactDone: false };
  return geometry;
}

// Returns a finished or abandoned scratch geometry to its source's pool. Only
// pass geometry that was never assigned to a mesh.
export function releaseCompactionScratch(source, geometry) {
  if (!geometry || geometry === source) return;
  let pool = scratchPools.get(source);
  if (!pool) scratchPools.set(source, pool = []);
  if (pool.length >= SCRATCH_POOL_LIMIT || pool.includes(geometry)) {
    if (!pool.includes(geometry)) geometry.dispose();
    return;
  }
  pool.push(geometry);
}

export function disposeCompactionScratch(source) {
  const pool = scratchPools.get(source);
  if (!pool) return;
  for (const geometry of pool) geometry.dispose();
  scratchPools.delete(source);
}

// Remove only stems already hidden by the terrain/path mask. Preserve their
// original instanceData.y identities for distance transitions.
export function compactGrassGeometry(source, centerX, centerZ, containsGrass, target = null, options = {}) {
  const position = source.getAttribute('instancePosition');
  // Reserve the source capacity once. Moving a tile must not destroy and
  // recreate renderer resources as its masked population grows and shrinks.
  const geometry = target ?? source.clone();
  // BufferGeometry.copy() shares userData by reference, and the resumable
  // progress below lives there: every tile compacting this LOD used to share
  // one cursor, so interleaved jobs skipped blades and published stale stems
  // piled at the tile centre.
  if (!target) geometry.userData = { ...source.userData };
  if (!target && position.itemSize === 3) {
    // WGSL storage vec3s have a vec4 stride. Allocate that layout before the
    // first upload so WebGPU never replaces/re-pads a recycled position array.
    geometry.setAttribute('instancePosition', new StorageInstancedBufferAttribute(
      new Float32Array(position.count * 4), 4,
    ));
  }
  const resume = options.resume === true && target != null;
  const start = resume ? (geometry.userData.compactCursor ?? 0) : 0;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : Infinity;
  if (start === 0) {
    geometry.userData.compactCount = 0;
    geometry.userData.compactCursor = 0;
    geometry.userData.compactDone = false;
  }
  const inputs = INSTANCE_ATTRIBUTES.map((name) => source.getAttribute(name));
  const outputs = INSTANCE_ATTRIBUTES.map((name) => geometry.getAttribute(name));
  let count = start === 0 ? 0 : (geometry.userData.compactCount ?? 0);
  const end = Math.min(source.instanceCount, start + limit);
  for (let i = start; i < end; i++) {
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
  geometry.userData.compactCursor = end;
  geometry.userData.compactCount = count;
  geometry.userData.compactDone = end >= source.instanceCount;
  if (!geometry.userData.compactDone) return geometry;
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
