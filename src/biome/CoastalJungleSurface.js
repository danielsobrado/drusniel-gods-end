import * as THREE from 'three';
import { mapCoastalJungleHorizontal } from './CoastalJunglePlacement.js';

const SURFACE_CHUNK_SIZE = 1024;

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function materialsOf(object) {
  return (Array.isArray(object?.material) ? object.material : [object?.material]).filter(Boolean);
}

function routeAwareOffset(paths, placement, x, z, baseOffset) {
  const mask = Number(paths?.sample?.(x, z) ?? 0);
  const start = Number(placement?.routeFloorRevealStart ?? 0.08);
  if (!(mask > start)) return baseOffset;
  const reveal = THREE.MathUtils.smoothstep(mask, start, 1);
  const depth = Number(placement?.routeFloorRevealDepth ?? 0.08);
  return THREE.MathUtils.lerp(baseOffset, -Math.abs(depth), reveal);
}

export async function conformCoastalJungleSurface({
  object,
  sourceBounds,
  region,
  sea,
  terrain,
  paths,
  placement,
  offset = 0,
  transparent = false,
  revealRoutes = false,
  signal = null,
  isDisposed = () => false,
}) {
  if (!object?.isMesh || !object.geometry?.attributes?.position) return;
  object.updateWorldMatrix(true, false);
  const sourceWorldMatrix = object.matrixWorld.clone();
  const inverse = sourceWorldMatrix.clone().invert();
  const positions = object.geometry.attributes.position;
  const source = new THREE.Vector3();
  const target = new THREE.Vector3();

  for (let index = 0; index < positions.count; index += 1) {
    source.fromBufferAttribute(positions, index).applyMatrix4(sourceWorldMatrix);
    const mapped = mapCoastalJungleHorizontal(source, sourceBounds, region, sea);
    if (mapped) {
      const height = terrain.sampleHeight(mapped.x, mapped.z);
      if (Number.isFinite(height)) {
        const surfaceOffset = revealRoutes
          ? routeAwareOffset(paths, placement, mapped.x, mapped.z, offset)
          : offset;
        target.set(mapped.x, height + surfaceOffset, mapped.z).applyMatrix4(inverse);
        positions.setXYZ(index, target.x, target.y, target.z);
      }
    }
    if ((index + 1) % SURFACE_CHUNK_SIZE === 0) {
      await nextTask();
      signal?.throwIfAborted();
      if (isDisposed()) return;
    }
  }

  positions.needsUpdate = true;
  object.geometry.computeVertexNormals();
  object.geometry.computeBoundingBox();
  object.geometry.computeBoundingSphere();
  object.castShadow = false;
  object.receiveShadow = true;
  if (!transparent) return;
  for (const material of materialsOf(object)) {
    material.transparent = true;
    material.depthWrite = false;
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.needsUpdate = true;
  }
  object.renderOrder = 1;
}
