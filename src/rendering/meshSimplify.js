import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';

/** Resolves once the simplifier's WASM is ready. */
export const meshSimplifierReady = MeshoptSimplifier.ready;

// meshopt_SimplifyVertex_Protect: in Permissive mode, collapses may move this
// vertex but may not cross the attribute seam it sits on.
const PROTECT_SEAM = 2;
// How much a collapse may distort texture coordinates, against the positional
// error (both relative to the mesh). Weighted so a UV island is not smeared
// across its neighbour's part of the atlas.
const UV_WEIGHT = 1;

// Vertices that share a position with a vertex carrying different UVs lie on
// a texture seam.
export function uvSeamLocks(positions, uvs) {
  const locks = new Uint8Array(positions.count);
  if (!uvs) return locks;
  const first = new Map();
  for (let index = 0; index < positions.count; index += 1) {
    const key = `${positions.getX(index)},${positions.getY(index)},${positions.getZ(index)}`;
    const other = first.get(key);
    if (other === undefined) { first.set(key, index); continue; }
    if (uvs.getX(other) !== uvs.getX(index) || uvs.getY(other) !== uvs.getY(index)) {
      locks[other] = PROTECT_SEAM;
      locks[index] = PROTECT_SEAM;
    }
  }
  return locks;
}

// Plain float UVs whatever the storage (glTF often quantizes them).
function readUvs(uvs) {
  const out = new Float32Array(uvs.count * 2);
  for (let index = 0; index < uvs.count; index += 1) {
    out[index * 2] = uvs.getX(index);
    out[index * 2 + 1] = uvs.getY(index);
  }
  return out;
}

// A cheaper stage of an indexed geometry that keeps its vertices, so skinning
// and UVs are untouched; only the index buffer is new. Permissive lets
// collapses cross normal and skinning splits, which otherwise pin most of a
// baked mesh in place, but UV seams are protected and UV distortion is
// weighted: without that, triangles collapsed across a seam sampled the wrong
// part of the atlas and showed as pale shards on the villagers' clothes.
// `ratio` bounds the triangle count and `error` (relative to the mesh extent)
// bounds the deviation; whichever is reached first stops simplification.
// Returns the source geometry when nothing can be saved.
export function simplifiedStage(geometry, { ratio = 0, error = 1 } = {}) {
  const source = geometry.index;
  const positions = geometry.attributes.position;
  // Simplification reorders the index, which would break material groups.
  if (!source || !positions || positions.isInterleavedBufferAttribute || geometry.groups.length > 1) return geometry;
  const indices = Uint32Array.from(source.array);
  const vertices = positions.array instanceof Float32Array ? positions.array : Float32Array.from(positions.array);
  const target = Math.floor(indices.length * ratio / 3) * 3;
  const uvs = geometry.attributes.uv;
  const [result] = uvs
    ? MeshoptSimplifier.simplifyWithAttributes(indices, vertices, positions.itemSize,
      readUvs(uvs), 2, [UV_WEIGHT, UV_WEIGHT], uvSeamLocks(positions, uvs), target, error, ['Permissive'])
    : MeshoptSimplifier.simplify(indices, vertices, positions.itemSize, target, error, ['Permissive']);
  if (!result.length || result.length >= indices.length) return geometry;
  const stage = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) stage.setAttribute(name, attribute);
  for (const [name, attributes] of Object.entries(geometry.morphAttributes)) stage.morphAttributes[name] = attributes;
  stage.morphTargetsRelative = geometry.morphTargetsRelative;
  stage.setIndex(new THREE.BufferAttribute(result, 1));
  stage.boundingBox = geometry.boundingBox?.clone() ?? null;
  stage.boundingSphere = geometry.boundingSphere?.clone() ?? null;
  return stage;
}
