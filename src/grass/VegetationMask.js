import * as THREE from 'three';
import { sampleGrassMask } from './sampleGrassMask.js';
import { dilatePathMask, dilationRadius, vegetationStrength } from './vegetationPolicy.js';

// The mask that decides where vegetation may grow: the authored path mask dilated
// by the configured clearance and hardened by the cutoff ramp. Kept separate from
// GrassMask's authoring canvas so the painter's export never widens the paths, and
// so the ground material keeps blending against the raw painted strokes.
//
// This is a CanvasTexture with exactly the settings GrassMask uses, including
// flipY = true, so the GPU reads it with the same orientation as before. See the
// convention note in vegetationPolicy.js.
export class VegetationMask {
  constructor(resolution, policy) {
    this.resolution = resolution;
    this.policy = policy;
    this.radius = { x: 0, y: 0 };
    this.canvas = document.createElement('canvas');
    this.canvas.width = resolution;
    this.canvas.height = resolution;
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.context.fillStyle = '#000000';
    this.context.fillRect(0, 0, resolution, resolution);
    this.imageData = this.context.getImageData(0, 0, resolution, resolution);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.flipY = true;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
  }

  // `rect` (pixels, undilated) restricts the work to a painted region; omit it for
  // a full rebuild after load/clear.
  rebuild(source, terrainSize, rect = null) {
    if (!source) return;
    const { width, height } = source;
    if (this.imageData.width !== width || this.imageData.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.imageData = this.context.createImageData(width, height);
    }
    this.radius = dilationRadius(this.policy.clearance, terrainSize, width, height);
    dilatePathMask(source.data, this.imageData.data, width, height, this.radius.x, this.radius.y, rect);
    this.context.putImageData(this.imageData, 0, 0);
    this.texture.needsUpdate = true;
  }

  sampleWorld(x, z, bounds) {
    if (!this.imageData) return 0;
    const { min, max } = bounds;
    if (x < min.x || x > max.x || z < min.z || z > max.z) return 0;
    const u = (x - min.x) / (max.x - min.x);
    const v = (z - min.z) / (max.z - min.z);
    const raw = sampleGrassMask(this.imageData, u, this.texture.flipY ? 1 - v : v);
    return vegetationStrength(raw, this.policy.cutoff, this.policy.softness);
  }

  allows(x, z, bounds) {
    return this.sampleWorld(x, z, bounds) > 0;
  }

  dispose() {
    this.texture.dispose();
  }
}
