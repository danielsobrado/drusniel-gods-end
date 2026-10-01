import { Fn, dot, float, floor, fract, fwidth, mix, sin, smoothstep, texture, vec2, vec3 } from 'three/tsl';

// Smooth random height and its analytic gradient. Quintic interpolation keeps
// both the pigment and the normal continuous across cell boundaries.
const turfNoise = Fn(([p]) => {
  const cell = floor(p);
  const local = fract(p);
  const weight = local.mul(local).mul(local).mul(local.mul(local.mul(6).sub(15)).add(10));
  const derivative = local.mul(local).mul(local.sub(1).pow2()).mul(30);
  const hash = offset => fract(sin(dot(cell.add(offset), vec2(127.1, 311.7))).mul(43758.5453));
  const a = hash(vec2(0, 0)), b = hash(vec2(1, 0));
  const c = hash(vec2(0, 1)), d = hash(vec2(1, 1));
  return vec3(
    mix(mix(a, b, weight.x), mix(c, d, weight.x), weight.y).mul(2).sub(1),
    mix(b.sub(a), d.sub(c), weight.y).mul(derivative.x).mul(2),
    mix(c.sub(a), d.sub(b), weight.x).mul(derivative.y).mul(2),
  );
}, 'vec3');

// Offset, rotate and rescale overlapping samples so the source image cannot
// read as rows of identical square tiles. Blend weights vary smoothly in world
// space, independently of the terrain's mesh UVs.
export function groundGrassTexture(map, coords, world) {
  const patch = turfNoise(world.mul(0.19)).x.mul(0.5).add(0.5);
  const warp = vec2(turfNoise(world.mul(0.31)).x, turfNoise(world.mul(0.31).add(17.3)).x).mul(0.28);
  const p = coords.add(warp);
  const rotated = vec2(dot(p, vec2(0.8, -0.6)), dot(p, vec2(0.6, 0.8)));
  const crossed = vec2(dot(p, vec2(-0.6, -0.8)), dot(p, vec2(0.8, -0.6)));
  return mix(
    mix(texture(map, p).rgb, texture(map, rotated.mul(1.37).add(vec2(0.37, 0.71))).rgb,
      smoothstep(0.2, 0.8, patch)),
    texture(map, crossed.mul(0.83).add(vec2(0.73, 0.29))).rgb,
    0.3,
  );
}

// Irregular, bent fibres and small tufts replace the crossed sine waves that
// looked like woven squares. Each band fades before it becomes subpixel;
// the stationary world-space pattern stays put when grass moves in the wind.
export const groundTurf = Fn(([world]) => {
  const bend = vec2(sin(dot(world, vec2(0.73, 1.21))), sin(dot(world, vec2(-1.13, 0.67)))).mul(0.18);
  const p = world.add(bend);
  const a = vec2(dot(p, vec2(18, 7)), dot(p, vec2(-1.5, 3.8)));
  const b = vec2(dot(p, vec2(-9, 16)), dot(p, vec2(-3.5, -2))).add(23.7);
  const c = vec2(dot(world, vec2(5.2, -3.9)), dot(world, vec2(3.9, 5.2))).add(41.3);
  const filtered = coords => {
    const footprint = fwidth(coords);
    return turfNoise(coords).mul(smoothstep(0.25, 0.9, footprint.x.max(footprint.y)).oneMinus());
  };
  const fibreA = filtered(a).toVar(), fibreB = filtered(b).toVar(), tufts = filtered(c).toVar();
  const pigment = fibreA.x.mul(0.45).add(fibreB.x.mul(0.35)).add(tufts.x.mul(0.2));
  const slope = vec2(18, 7).mul(fibreA.y).add(vec2(-1.5, 3.8).mul(fibreA.z)).mul(0.0025)
    .add(vec2(-9, 16).mul(fibreB.y).add(vec2(-3.5, -2).mul(fibreB.z)).mul(0.002))
    .add(vec2(5.2, -3.9).mul(tufts.y).add(vec2(3.9, 5.2).mul(tufts.z)).mul(0.003));
  return vec3(pigment, slope);
}, 'vec3');

// Damp soil can carry a broad highlight; tangled turf stays rough even at the
// shoreline or in rain. Sharing the mask's eased edge keeps the material blend
// aligned with its colour, instead of leaving a glossy fringe around paths.
export function groundRoughness(soil, soilRoughness, wet, turfDetail) {
  const dry = mix(float(0.96).add(turfDetail.mul(0.02)), soilRoughness.max(0.65), soil);
  return mix(dry, mix(0.82, 0.48, soil), wet.clamp(0, 1));
}
