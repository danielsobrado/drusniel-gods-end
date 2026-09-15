import { Fn, dot, fract, vec2, vec3 } from 'three/tsl';

// TSL ports of Snowflow's `lib/noise.wgsl` hashes and gradient noise (MIT,
// Maksymilian Dendura). Declared with layouts so each becomes one shader
// function however many call sites use it.

export const hash21 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
}).setLayout({ name: 'snowHash21', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

export const hash22 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(vec2(p3.x, p3.x).add(vec2(p3.y, p3.z)).mul(vec2(p3.z, p3.y)));
}).setLayout({ name: 'snowHash22', type: 'vec2', inputs: [{ name: 'p', type: 'vec2' }] });

/** Perlin-style gradient noise with a quintic fade; roughly [-0.7, 0.7]. */
export const noise2 = Fn(([p]) => {
  const cell = p.floor();
  const f = p.sub(cell);
  const u = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
  const corner = (x, y) => {
    const angle = hash21(cell.add(vec2(x, y))).mul(Math.PI * 2);
    return dot(vec2(angle.cos(), angle.sin()), f.sub(vec2(x, y)));
  };
  const va = corner(0, 0);
  const vb = corner(1, 0);
  const vc = corner(0, 1);
  const vd = corner(1, 1);
  return va
    .add(vb.sub(va).mul(u.x))
    .add(vc.sub(va).mul(u.y))
    .add(va.sub(vb).sub(vc).add(vd).mul(u.x).mul(u.y));
}).setLayout({ name: 'snowNoise2', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });
