import { Fn, cos, dot, float, fwidth, mix, sin, smoothstep, vec2, vec3 } from 'three/tsl';

// Stationary, crossed fibres break up the flat turf between actual blades.
// Fade each frequency before it becomes subpixel; wind belongs to the geometry.
export const groundTurf = Fn(([world]) => {
  const a = dot(world, vec2(43, 17)).add(sin(dot(world, vec2(1.7, 2.3))).mul(2));
  const b = dot(world, vec2(-27, 61)).add(sin(dot(world, vec2(2.1, -1.1))).mul(2));
  const filterA = smoothstep(0.6, 2.4, fwidth(a)).oneMinus();
  const filterB = smoothstep(0.6, 2.4, fwidth(b)).oneMinus();
  const pigment = sin(a).mul(filterA).add(sin(b).mul(filterB)).mul(0.5);
  const slope = vec2(0.12, 0.05).mul(cos(a)).mul(filterA)
    .add(vec2(-0.04, 0.1).mul(cos(b)).mul(filterB));
  return vec3(pigment, slope);
}, 'vec3');

// Damp soil can carry a broad highlight; tangled turf stays rough even at the
// shoreline or in rain. Sharing the mask's eased edge keeps the material blend
// aligned with its colour, instead of leaving a glossy fringe around paths.
export function groundRoughness(soil, soilRoughness, wet, turfDetail) {
  const dry = mix(float(0.96).add(turfDetail.mul(0.02)), soilRoughness.max(0.65), soil);
  return mix(dry, mix(0.82, 0.48, soil), wet.clamp(0, 1));
}
