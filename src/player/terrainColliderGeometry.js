import * as THREE from 'three';

export function createWorldSpacePositions(object) {
  const positions = object.geometry?.attributes?.position;
  if (!positions) return null;

  object.updateWorldMatrix(true, false);
  const vertices = new Float32Array(positions.count * 3);
  const vertex = new THREE.Vector3();
  for (let index = 0; index < positions.count; index += 1) {
    vertex.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld);
    vertices[index * 3] = vertex.x;
    vertices[index * 3 + 1] = vertex.y;
    vertices[index * 3 + 2] = vertex.z;
  }
  return vertices;
}

export function createTerrainIndices(geometry) {
  if (geometry.index?.array) return geometry.index.array;
  const indices = new Uint32Array(geometry.attributes.position.count);
  for (let index = 0; index < indices.length; index += 1) indices[index] = index;
  return indices;
}
