import * as THREE from 'three';
import { coastalJungleRegionWeight } from '../world/CoastalJungleRegion.js';
import { mapCoastalJungleHorizontal } from './CoastalJunglePlacement.js';

const SURFACE_CHUNK_SIZE = 1024;
const DEFAULT_SURFACE_EDGE_FADE = 18;
const ROUTE_FLOOR_MIN_OFFSET = 0.006;
const SURFACE_ALPHA_TEST = 0.01;

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function materialsOf(object) {
  return (Array.isArray(object?.material) ? object.material : [object?.material]).filter(Boolean);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function coastalJungleRouteOffset(baseOffset, depth, reveal) {
  const base = Math.max(0, Number(baseOffset) || 0);
  const minimum = Math.min(base, ROUTE_FLOOR_MIN_OFFSET);
  const target = Math.max(minimum, base - Math.max(0, Number(depth) || 0));
  return THREE.MathUtils.lerp(base, target, clamp01(reveal));
}

function routeAwareOffset(paths, placement, x, z, baseOffset) {
  const mask = Number(paths?.sample?.(x, z) ?? 0);
  const start = Number(placement?.routeFloorRevealStart ?? 0.08);
  if (!(mask > start)) return baseOffset;
  const reveal = THREE.MathUtils.smoothstep(mask, start, 1);
  return coastalJungleRouteOffset(
    baseOffset,
    placement?.routeFloorRevealDepth ?? 0.08,
    reveal,
  );
}

function writeTransitionColor(target, index, source, alpha) {
  const offset = index * 4;
  target[offset] = source?.getX(index) ?? 1;
  target[offset + 1] = source?.getY(index) ?? 1;
  target[offset + 2] = source?.getZ(index) ?? 1;
  target[offset + 3] = (source?.itemSize >= 4 ? source.getW(index) : 1) * clamp01(alpha);
}

function prepareTransitionMaterial(object, pathSurface) {
  for (const material of materialsOf(object)) {
    material.vertexColors = true;
    material.transparent = true;
    material.depthWrite = false;
    material.alphaTest = Math.max(Number(material.alphaTest) || 0, SURFACE_ALPHA_TEST);
    material.polygonOffset = true;
    material.polygonOffsetFactor = pathSurface ? -2 : -1;
    material.needsUpdate = true;
  }
  object.renderOrder = pathSurface ? 2 : 1;
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
  const sourceColors = object.geometry.getAttribute('color');
  const edgeFade = Math.max(0, Number(placement?.surfaceEdgeFade ?? DEFAULT_SURFACE_EDGE_FADE));
  const transitionColors = edgeFade > 0 ? new Float32Array(positions.count * 4) : null;
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
      if (transitionColors) {
        writeTransitionColor(
          transitionColors,
          index,
          sourceColors,
          coastalJungleRegionWeight(mapped.x, mapped.z, region, sea, edgeFade),
        );
      }
    } else if (transitionColors) {
      writeTransitionColor(transitionColors, index, sourceColors, 0);
    }
    if ((index + 1) % SURFACE_CHUNK_SIZE === 0) {
      await nextTask();
      signal?.throwIfAborted();
      if (isDisposed()) return;
    }
  }

  positions.needsUpdate = true;
  if (transitionColors) object.geometry.setAttribute('color', new THREE.BufferAttribute(transitionColors, 4));
  object.geometry.computeVertexNormals();
  object.geometry.computeBoundingBox();
  object.geometry.computeBoundingSphere();
  object.castShadow = false;
  object.receiveShadow = true;

  if (transitionColors || transparent) prepareTransitionMaterial(object, transparent);
}
