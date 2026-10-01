import { Vector4 } from 'three';

const corner = new Vector4();

// A box crossing the near plane (or containing the eye) must stay visible.
// Project all eight corners, then round outwards to cover every touched pixel.
export function projectOcclusionBounds(box, projectionView, width, height, padding = 2) {
  if (box.isEmpty()) return null;
  let minX = 1;
  let minY = 1;
  let maxX = -1;
  let maxY = -1;
  let depth = 1;
  for (let i = 0; i < 8; i++) {
    corner.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
      1,
    ).applyMatrix4(projectionView);
    if (corner.w <= 0 || corner.z <= 0) return null;
    const x = corner.x / corner.w;
    const y = corner.y / corner.w;
    depth = Math.min(depth, corner.z / corner.w);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (![minX, minY, maxX, maxY, depth].every(Number.isFinite)) return null;
  return {
    minX: Math.max(0, Math.floor((minX * 0.5 + 0.5) * width) - padding),
    minY: Math.max(0, Math.floor((0.5 - maxY * 0.5) * height) - padding),
    maxX: Math.min(width - 1, Math.ceil((maxX * 0.5 + 0.5) * width) + padding),
    maxY: Math.min(height - 1, Math.ceil((0.5 - minY * 0.5) * height) + padding),
    depth,
  };
}

export function occlusionDrawRange(object, material, group = null) {
  const geometry = object.geometry;
  if (!geometry || geometry.indirect || material.wireframe || object.isBatchedMesh) return null;
  const count = geometry.index?.count ?? geometry.attributes.position?.count ?? 0;
  const first = Math.max(0, geometry.drawRange.start, group?.start ?? 0);
  const end = Math.min(count, geometry.drawRange.start + geometry.drawRange.count,
    group ? group.start + group.count : Infinity);
  const instances = geometry.isInstancedBufferGeometry ? geometry.instanceCount : (object.count ?? 1);
  if (!Number.isFinite(instances) || instances <= 0 || end <= first) return null;
  return { count: end - first, first, instances };
}

export function isSolidOccluder(object) {
  const material = object.material;
  return Boolean(object.isMesh && !object.isSkinnedMesh && !object.isInstancedMesh
    && !object.geometry?.isInstancedBufferGeometry && !object.geometry?.indirect && !object.morphTargetInfluences?.length
    && object.userData.occlusionOccluder !== false && !Array.isArray(material)
    && material?.visible && material.depthWrite && material.depthTest && material.opacity === 1
    && !material.transparent && !material.alphaTest && !material.alphaHash && !material.alphaMap
    && !material.alphaTestNode && !material.opacityNode && !material.maskNode
    && !material.positionNode && !material.vertexNode && !material.fragmentNode && !material.depthNode
    && !material.displacementMap && !material.transmission && !material.polygonOffset
    && !material.clippingPlanes?.length && !material.wireframe);
}
