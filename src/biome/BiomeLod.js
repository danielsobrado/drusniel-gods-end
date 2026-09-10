import { attribute, cameraPosition, interleavedGradientNoise, screenCoordinate, smoothstep } from 'three/tsl';

const PADDING = 2;

/** Complementary near/mid/far membership with overlap for dithered handoff. */
export class BiomeLod {
  constructor(capacity) {
    this.near = new Uint32Array(capacity);
    this.mid = new Uint32Array(capacity);
    this.far = new Uint32Array(capacity);
    this.nearCount = 0;
    this.midCount = 0;
    this.farCount = 0;
  }

  partition(origins, count, camera, nearStart, nearEnd, farStart, farEnd, { rocks = false } = {}) {
    this.nearCount = this.midCount = this.farCount = 0;
    const nearLimit = (nearEnd + PADDING) ** 2;
    const midInner = Math.max(0, nearStart - PADDING) ** 2;
    const midOuter = (farEnd + PADDING) ** 2;
    const farLimit = Math.max(0, farStart - PADDING) ** 2;
    for (let i = 0; i < count; i++) {
      const distance = (origins[i * 3] - camera.x) ** 2 + (origins[i * 3 + 2] - camera.z) ** 2;
      if (distance <= nearLimit) this.near[this.nearCount++] = i;
      if (rocks) {
        if (distance >= midInner) this.mid[this.midCount++] = i;
        continue;
      }
      if (distance >= midInner && distance <= midOuter) this.mid[this.midCount++] = i;
      if (distance >= farLimit) this.far[this.farCount++] = i;
    }
    return this;
  }
}

export function biomeCoverage(nearStart, nearEnd, farStart, farEnd) {
  const origin = attribute('clumpOrigin', 'vec3');
  const distance = origin.xz.sub(cameraPosition.xz).length();
  const noise = interleavedGradientNoise(screenCoordinate.xy);
  const nearBlend = smoothstep(nearStart, nearEnd, distance);
  const farBlend = smoothstep(farStart, farEnd, distance);
  return {
    near: noise.greaterThanEqual(nearBlend),
    mid: noise.lessThan(nearBlend).and(noise.greaterThanEqual(farBlend)),
    far: noise.lessThan(farBlend),
  };
}
