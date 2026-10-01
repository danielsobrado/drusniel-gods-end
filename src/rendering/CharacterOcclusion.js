import * as THREE from 'three';
import { float, interleavedGradientNoise, positionView, screenCoordinate, smoothstep, uniform, vec2 } from 'three/tsl';

// Foliage between the camera and the character is dithered away in a soft
// circle around the character's on-screen silhouette, so leaves never hide the
// player. Only fragments nearer the camera than the character are cut, so the
// canopy behind the player stays whole, and the cut applies to colour passes
// only (a material's maskShadowNode is left alone, so shadows are unchanged).
// Solid obstacles are handled by the camera boom instead (PlayerController).

const center = uniform(new THREE.Vector2(-1e4, -1e4));
const radius = uniform(0);
const depth = uniform(0);
const strength = uniform(0);
const EDGE_EPSILON = 1e-3;

/** Boolean TSL node: true where a fragment should be kept. And it into maskNode. */
export function characterOcclusionKeep() {
  const offset = screenCoordinate.xy.sub(center);
  const distance = offset.length();
  // 1 inside the circle, fading to 0 across its outer 40%.
  // (smoothstep with reversed edges is undefined in WGSL/GLSL, so fade in and invert.)
  // Edges are kept apart: before the first update (and whenever the cut is
  // off) radius and depth are 0, smoothstep with equal edges is undefined in
  // WGSL, and the NaN it returned discarded every fragment, so near trees
  // vanished while the tour or free-fly camera was active.
  const inside = smoothstep(radius.mul(0.6), radius.max(EDGE_EPSILON), distance).oneMinus();
  // Only in front of the character: fragments within a body's depth of it or
  // behind it are kept.
  const nearEdge = depth.mul(0.8);
  const inFront = smoothstep(nearEdge, depth.mul(0.92).max(nearEdge.add(EDGE_EPSILON)), positionView.z.negate()).oneMinus();
  const cut = inside.mul(inFront).mul(strength);
  const noise = interleavedGradientNoise(screenCoordinate.xy.add(vec2(17, 5)));
  return strength.lessThanEqual(0).or(noise.greaterThanEqual(cut.mul(float(0.97))));
}

const scratch = new THREE.Vector3();
const bufferSize = new THREE.Vector2();

/**
 * Per-frame update from the character's centre and height in world units.
 * Coordinates match `screenCoordinate` (physical pixels, top-left origin).
 */
export function updateCharacterOcclusion({ renderer, camera, target, height, enabled = true }) {
  if (!enabled || !target || !camera || !(height > 0)) {
    strength.value = 0;
    return;
  }
  renderer.getDrawingBufferSize(bufferSize);
  const viewDepth = scratch.copy(target).applyMatrix4(camera.matrixWorldInverse).z * -1;
  if (!(viewDepth > camera.near)) {
    strength.value = 0;
    return;
  }
  scratch.copy(target).project(camera);
  center.value.set((scratch.x * 0.5 + 0.5) * bufferSize.x, (0.5 - scratch.y * 0.5) * bufferSize.y);
  const pixelsPerUnit = bufferSize.y / (2 * viewDepth * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  // A circle a little taller than the character reads as a clean window.
  radius.value = height * 0.75 * pixelsPerUnit;
  depth.value = viewDepth;
  strength.value = 1;
}

