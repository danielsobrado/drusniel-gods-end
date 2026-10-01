import {
  cross, dot, float, mix, normalize, select, smoothstep, vec3,
} from 'three/tsl';
import { hash22 } from './snowNoiseNodes.js';

// TSL ports of the snow-specific terms in Snowflow's `lib/shading.wgsl` (MIT,
// Maksymilian Dendura). Three's own BRDF handles the microfacet lobes; these add
// what a standard material leaves out of snow.

// Back-scatter transmission: light that entered the snow, scattered and left
// toward the eye. A thin edge transmits brightly over a wide range of angles,
// deep snow only near straight-through, and longer paths come back bluer.
// `light` points from the surface toward the sun.
export function snowSubsurface({ normal, light, view, lightColor, thickness, strength, radius }) {
  const tint = mix(vec3(0.94, 0.965, 1), vec3(0.55, 0.72, 1), thickness.mul(radius).clamp(0, 1));
  const transmitted = normalize(light.add(normal.mul(0.28 * radius)));
  const lobe = dot(view, transmitted.negate()).clamp(0, 1)
    .pow(mix(float(3), float(9), thickness))
    .mul(mix(float(1), float(0.3), thickness));
  return lightColor.mul(tint).mul(lobe).mul(strength);
}

// One octave of discrete surface sparkle. Each world-space cell owns one
// jittered facet, so a glint is nailed to the ground and does not crawl.
function glintOctave(p, cell, normal, halfVector, tangent, bitangent, sharpness) {
  const id = p.div(cell).floor();
  const jitter = hash22(id);
  const facetSeed = hash22(id.add(vec2Like(19.73, 7.31)));
  const centre = id.add(0.5).add(jitter.sub(0.5).mul(0.72)).mul(cell);
  const distance = p.sub(centre).length().div(cell * 0.17);
  const disc = distance.mul(distance).oneMinus().clamp(0, 1);
  const angle = jitter.y.mul(Math.PI * 2);
  const tilt = facetSeed.y.mul(0.26).add(0.1);
  const facet = normalize(normal.add(tangent.mul(angle.cos()).add(bitangent.mul(angle.sin())).mul(tilt)));
  const response = disc.mul(dot(facet, halfVector).clamp(0, 1).pow(sharpness));
  // Only a fraction of cells hold a facet oriented to catch anything.
  return select(facetSeed.x.greaterThan(0.62), float(0), response);
}

function vec2Like(x, y) {
  return vec3(x, y, 0).xy;
}

// Grazing-gated glints: snow sparkles looking across it into the sun and stays
// matte looking down at it. Each octave fades once its cell drops below a few
// pixels instead of shrinking, so it never aliases or crawls. `worldScale`
// converts Snowflow's centimetre cells to this world's units.
export function snowGlints({ worldXZ, normal, view, light, footprint, intensity, grazing, worldScale }) {
  const halfVector = normalize(view.add(light));
  const up = select(normal.y.abs().greaterThan(0.95), vec3(1, 0, 0), vec3(0, 1, 0));
  const tangent = normalize(cross(up, normal));
  const bitangent = cross(normal, tangent);
  const graze = dot(normal, view).clamp(0, 1).oneMinus().pow(1.5 + 3.5 * grazing);
  const facingSun = dot(normal, light).clamp(0, 1);
  const lightGate = smoothstep(0.02, 0.35, facingSun).mul(smoothstep(0.55, 0.95, facingSun).mul(0.55).oneMinus());

  const cellA = 0.052 * worldScale;
  const cellB = 0.185 * worldScale;
  const fadeA = smoothstep(cellA * 0.55, cellA * 2.2, footprint).oneMinus();
  const fadeB = smoothstep(cellB * 0.55, cellB * 2.2, footprint).oneMinus();
  const fine = glintOctave(worldXZ, cellA, normal, halfVector, tangent, bitangent, 780).mul(fadeA);
  const coarse = glintOctave(worldXZ.add(vec2Like(53.1, 17.9)), cellB, normal, halfVector, tangent, bitangent, 1500)
    .mul(fadeB).mul(1.35);
  return fine.add(coarse).mul(graze).mul(lightGate).mul(intensity);
}
