import * as THREE from 'three/webgpu';
import { abs, cameraPosition, dot, float, mix, normalWorldGeometry, positionWorld,
  smoothstep, texture, uniform, uv, vec2 } from 'three/tsl';
import { createRandom } from '../utils/random.js';

export const BARRIER_DEFAULTS = Object.freeze({
  enabled: false,
  height: 12,
  color: '#55e8ff',
  accentColor: '#a477ff',
  opacity: 0.32,
  glowStrength: 8,
  noiseScale: 0.035,
  noiseSpeed: 0.035,
  fresnelPower: 3,
  proximityRadius: 16,
});

export function resolveBarrierSettings(settings = {}) {
  const result = { ...BARRIER_DEFAULTS, ...settings };
  const ranges = { height: [0.1, 100], opacity: [0, 1], glowStrength: [0, 40],
    noiseScale: [0.001, 1], noiseSpeed: [0, 1], fresnelPower: [0.1, 12], proximityRadius: [0.1, 100] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isFinite(result[key]) || result[key] < min || result[key] > max) {
      throw new Error(`boundaryBarrier.${key} must be a finite number between ${min} and ${max}.`);
    }
  }
  for (const key of ['color', 'accentColor']) {
    if (!/^#[\da-f]{6}$/i.test(result[key])) throw new Error(`boundaryBarrier.${key} must be a six-digit hex color.`);
  }
  if (typeof result.enabled !== 'boolean') throw new Error('boundaryBarrier.enabled must be boolean.');
  return result;
}

/** Deterministic, tileable value noise: no image download or per-frame CPU work. */
export function createBarrierNoise() {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  const random = createRandom(0xba771e);
  const octaves = [4, 8, 16].map(cells => ({ cells, grid: Array.from({ length: cells * cells }, random) }));
  const fade = t => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value = 0, weight = 1, total = 0;
      for (const { cells, grid } of octaves) {
        const px = x / (size - 1) * cells, py = y / (size - 1) * cells;
        const ix = Math.floor(px), iy = Math.floor(py);
        const tx = fade(px - ix), ty = fade(py - iy);
        const at = (gx, gy) => grid[(gy % cells) * cells + gx % cells];
        value += THREE.MathUtils.lerp(THREE.MathUtils.lerp(at(ix, iy), at(ix + 1, iy), tx),
          THREE.MathUtils.lerp(at(ix, iy + 1), at(ix + 1, iy + 1), tx), ty) * weight;
        total += weight;
        weight *= 0.5;
      }
      const offset = (y * size + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = Math.round(value / total * 255);
      data[offset + 3] = 255;
    }
  }
  const result = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  result.name = 'BarrierSeamlessNoise';
  result.wrapS = result.wrapT = THREE.RepeatWrapping;
  result.magFilter = THREE.LinearFilter;
  result.minFilter = THREE.LinearMipmapLinearFilter;
  result.generateMipmaps = true;
  result.needsUpdate = true;
  return result;
}

export function createBoundaryMaterial(settings, geometry, noise) {
  const uniforms = {
    clock: uniform(0),
    playerPosition: uniform(new THREE.Vector3(1e6, 1e6, 1e6)),
    fogDensity: uniform(0),
  };
  const { perimeter, height, skirt } = geometry.userData;
  // Integer repeats close the noise seam exactly, even on a non-square boundary.
  const repeats = Math.max(1, Math.round(perimeter * settings.noiseScale));
  const coord = vec2(uv().x.mul(repeats), uv().y.mul((height + skirt) * settings.noiseScale));
  const clock = uniforms.clock.mul(settings.noiseSpeed);
  const broad = texture(noise, coord.add(vec2(clock.mul(0.3), clock.negate()))).r;
  const fine = texture(noise, coord.mul(3).add(vec2(clock.negate(), clock.mul(0.65)))).r;
  const flow = broad.mul(0.72).add(fine.mul(0.28));
  const wisps = float(1).sub(smoothstep(0.015, 0.11, abs(flow.sub(0.52))));
  const view = cameraPosition.sub(positionWorld).normalize();
  const fresnel = float(1).sub(abs(dot(normalWorldGeometry.normalize(), view)).clamp(0, 1)).pow(settings.fresnelPower);
  const localHeight = uv().y.mul(height + skirt).sub(skirt);
  const groundGlow = abs(localHeight).mul(-2.2).exp();
  const fadeTop = float(1).sub(smoothstep(0.65, 1, uv().y));
  const fadeBottom = smoothstep(-skirt, 0, localHeight);
  const proximity = float(1).sub(smoothstep(0, settings.proximityRadius,
    positionWorld.distance(uniforms.playerPosition)));
  const energy = float(0.09).add(wisps.mul(0.48)).add(fresnel.mul(0.65)).add(groundGlow.mul(0.8));
  const color = mix(uniform(new THREE.Color(settings.color)), uniform(new THREE.Color(settings.accentColor)),
    smoothstep(0.35, 0.7, fine).mul(0.7));
  const material = new THREE.MeshBasicNodeMaterial({
    name: 'BoundaryForceField', transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, depthTest: true, side: THREE.DoubleSide, forceSinglePass: true, fog: false,
  });
  material.colorNode = color.mul(settings.glowStrength).mul(energy);
  // Fade energy out in fog instead of adding the fog color as a luminous rectangle.
  const fogFade = positionWorld.distance(cameraPosition).mul(uniforms.fogDensity).pow(2).negate().exp();
  material.opacityNode = float(settings.opacity).mul(float(0.3).add(proximity.mul(0.7)))
    .mul(fadeTop).mul(fadeBottom).mul(fogFade);
  return { material, uniforms };
}
