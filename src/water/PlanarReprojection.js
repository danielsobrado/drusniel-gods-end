import * as THREE from 'three/webgpu';
// Deliberately per-object uniforms, not rendering/sharedUniform.js: capture()
// writes them from the reflector's updateBefore, in the middle of the main
// render call, and the water must see the new capture camera in that same
// frame or it samples the fresh texture through the previous capture's matrix.
import { cameraPosition, float, max, positionWorld, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';

// Wide screens run out of capture sideways long before they do vertically.
const DEFAULT_OVERSCAN = Object.freeze([1.35, 1.15]);
const _saved = new THREE.Matrix4();

export function resolveOverscan(value) {
  const pair = Array.isArray(value) ? value : value === undefined ? DEFAULT_OVERSCAN : [value, value];
  return pair.slice(0, 2).map((entry, index) => {
    const number = Number(entry);
    return Number.isFinite(number) && number >= 1 ? number : DEFAULT_OVERSCAN[index];
  });
}

/**
 * Budgeted planar captures go stale between refreshes. Sampling them by
 * screen position makes the reflection swim as soon as the view turns, so the
 * water instead projects the direction of its reflected ray through the
 * rotation of the virtual camera the capture was taken with, treating what the
 * ray sees as distant. A fresh capture samples exactly as before, rotation
 * stays exact, and moving leaves a parallax error of about the distance moved
 * over the reflected object's distance until the next capture. Reprojecting
 * the water point itself instead shears the image, because that point is only
 * a few metres from the camera. The
 * capture is taken with a wider field of view so turning does not immediately
 * run off its edge; just past the edge the border texels stretch (the sampler
 * clamps), and only well beyond it does the caller's fallback take over.
 */
export class PlanarReprojection {
  constructor(reflectorNode, { overscan } = {}) {
    this.reflector = reflectorNode.reflector ?? reflectorNode;
    [this.overscanX, this.overscanY] = resolveOverscan(overscan);
    this.viewProjection = uniform(new THREE.Matrix4());
    this.valid = uniform(0);
  }

  /** Runs one reflector capture with a widened frustum and records its camera. */
  capture(camera, render) {
    const projection = camera.projectionMatrix;
    _saved.copy(projection);
    const e = projection.elements;
    for (const index of [0, 4, 8, 12]) e[index] /= this.overscanX;
    for (const index of [1, 5, 9, 13]) e[index] /= this.overscanY;
    try {
      render();
    } finally {
      projection.copy(_saved);
    }
    if (!this.reflector.hasOutput) {
      this.valid.value = 0;
      return;
    }
    const virtual = this.reflector.getVirtualCamera(camera);
    this.viewProjection.value.multiplyMatrices(virtual.projectionMatrix, virtual.matrixWorldInverse);
    this.valid.value = 1;
  }

  /** Capture UV for the current fragment and a 0..1 weight that falls to 0 well outside the capture. */
  uvNode() {
    // Mirrored ray from the mirrored camera through the mirrored surface point;
    // w = 0 keeps only the capture camera's rotation.
    const ray = positionWorld.sub(cameraPosition).mul(vec3(1, -1, 1));
    const clip = this.viewProjection.mul(vec4(ray, 0));
    const ndc = clip.xy.div(clip.w.max(1e-4));
    const uv = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5));
    const outside = uv.sub(1).max(uv.negate()).max(0);
    const weight = float(1).sub(smoothstep(0.04, 0.3, max(outside.x, outside.y)))
      .mul(clip.w.greaterThan(0).select(float(1), float(0)))
      .mul(this.valid);
    return { uv, weight };
  }
}
