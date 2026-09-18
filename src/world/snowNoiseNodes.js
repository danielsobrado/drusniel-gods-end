import { Fn, If, dot, float, fract, mix, smoothstep, vec2, vec3 } from 'three/tsl';

// TSL ports of Snowflow's `lib/noise.wgsl` and the fine layer of
// `lib/terrain.wgsl` (MIT, Maksymilian Dendura). Declared with layouts so each
// becomes one shader function however many call sites use it.

const TAU = Math.PI * 2;
// Per-octave rotation of the ridged noise, which kills the axis-aligned grid
// signature of raw gradient noise.
const RIDGE_ROTATION = 0.717;
const RIDGE_LACUNARITY = 2.11;
const RIDGE_GAIN = 0.52;
const RIDGE_OCTAVES = 3;

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
    const angle = hash21(cell.add(vec2(x, y))).mul(TAU);
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

function latticeGradient(cell) {
  const angle = hash21(cell).mul(TAU);
  return vec2(angle.cos(), angle.sin()).toVar();
}

/**
 * The same gradient noise with Inigo Quilez's analytic derivatives:
 * vec3(value, d/dx, d/dy). Exact slopes are what let the fine relief be
 * shaded without a finite difference.
 */
export const noised = Fn(([p]) => {
  const cell = p.floor().toVar();
  const f = p.sub(cell).toVar();
  const u = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10)).toVar();
  const du = f.mul(f).mul(f.mul(f.sub(2)).add(1)).mul(30);
  const ga = latticeGradient(cell);
  const gb = latticeGradient(cell.add(vec2(1, 0)));
  const gc = latticeGradient(cell.add(vec2(0, 1)));
  const gd = latticeGradient(cell.add(vec2(1, 1)));
  const va = dot(ga, f).toVar();
  const vb = dot(gb, f.sub(vec2(1, 0)));
  const vc = dot(gc, f.sub(vec2(0, 1)));
  const vd = dot(gd, f.sub(vec2(1, 1)));
  const k1 = vb.sub(va).toVar();
  const k2 = vc.sub(va).toVar();
  const k3 = va.sub(vb).sub(vc).add(vd).toVar();
  const value = va.add(k1.mul(u.x)).add(k2.mul(u.y)).add(k3.mul(u.x).mul(u.y));
  const derivative = ga
    .add(gb.sub(ga).mul(u.x))
    .add(gc.sub(ga).mul(u.y))
    .add(ga.sub(gb).sub(gc).add(gd).mul(u.x.mul(u.y)))
    .add(du.mul(vec2(u.y, u.x).mul(k3).add(vec2(k1, k2))));
  return vec3(value, derivative);
}).setLayout({ name: 'snowNoised', type: 'vec3', inputs: [{ name: 'p', type: 'vec2' }] });

// Counter-clockwise rotation by a constant angle.
function rotate(v, angle) {
  if (angle === 0) return v;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return vec2(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)));
}

/**
 * Ridged noise with derivatives: sharp crests, smooth troughs. Built as
 * (1 - |n|)^2, with each octave weighted by the one before so the ridges
 * align. Octave k samples R(-k * rotation) p, so its slope maps back through
 * R(k * rotation).
 */
export const ridged = Fn(([p]) => {
  const sum = float(0).toVar();
  const slope = vec2(0).toVar();
  const previous = float(1).toVar();
  let amplitude = 0.5;
  let frequency = 1;
  for (let octave = 0; octave < RIDGE_OCTAVES; octave += 1) {
    const n = noised(rotate(p, -octave * RIDGE_ROTATION).mul(frequency)).toVar();
    const ridge = n.x.abs().oneMinus().toVar();
    const crest = ridge.mul(ridge).toVar();
    const crestSlope = ridge.mul(n.x.sign()).mul(-2);
    sum.addAssign(crest.mul(previous).mul(amplitude));
    slope.addAssign(rotate(n.yz.mul(crestSlope), octave * RIDGE_ROTATION).mul(previous).mul(amplitude * frequency));
    previous.assign(mix(float(1), crest, 0.65));
    amplitude *= RIDGE_GAIN;
    frequency *= RIDGE_LACUNARITY;
  }
  return vec3(sum, slope);
}).setLayout({ name: 'snowRidged', type: 'vec3', inputs: [{ name: 'p', type: 'vec2' }] });

// Snowflow's windMat: rotate into (along, across) the wind, then scale each
// axis. `alongScale` and `acrossScale` already include 1 / wavelength.
function toWind(p, c, s, alongScale, acrossScale) {
  return vec2(
    p.x.mul(c).add(p.y.mul(s)).mul(alongScale),
    p.y.mul(c).sub(p.x.mul(s)).mul(acrossScale),
  );
}

// The transpose of toWind: carries a slope in wind space back to world XZ.
function fromWind(slope, c, s, alongScale, acrossScale) {
  const along = slope.x.mul(alongScale);
  const across = slope.y.mul(acrossScale);
  return vec2(along.mul(c).sub(across.mul(s)), along.mul(s).add(across.mul(c)));
}

/**
 * Snowflow's footprint-filtered fine layer (`terrainFineFiltered`): wind-
 * streaked sastrugi, transverse wind ripples and grain. Everything is in
 * Snowflow metres; returns vec3(height, dH/dx, dH/dz), and the slopes carry to
 * any world scale unchanged.
 *
 * `exposure` (0 sheltered, 1 scoured) cross-fades the two wind layers: crests
 * are carved into hard sastrugi and hollows keep their ripples. `footprint` is
 * the world size of the pixel, and each layer fades out before its wavelength
 * drops under it, which is what stops the relief from crawling as moire.
 * `strength` scales (sastrugi, ripples, grain).
 */
export const snowFineRelief = Fn(([p, wind, exposure, footprint, strength]) => {
  const height = float(0).toVar();
  const slope = vec2(0).toVar();

  // One global bearing reads as corduroy. The wind veers across the field
  // (~120 m) and the sastrugi are streakier in some places than others (~80 m).
  const veer = noised(p.mul(0.0083).add(vec2(31.7, 12.3))).x.mul(0.42).toVar();

  // Sastrugi: ridged noise compressed across the wind, so crests streak along
  // it; ~2.3 m wavelength, standing up to ~12 cm proud on scoured ground.
  const sastrugiFade = smoothstep(0.35, 1.6, footprint).oneMinus().mul(strength.x).toVar();
  If(sastrugiFade.greaterThan(0.001), () => {
    const stretch = noised(p.mul(0.0126).add(vec2(7.1, 41.9))).x.mul(1.2).add(3.5);
    const angle = wind.add(veer).toVar();
    const c = angle.cos().toVar();
    const s = angle.sin().toVar();
    const along = 1 / 2.3;
    const across = stretch.div(2.3).toVar();
    const crest = ridged(toWind(p, c, s, along, across)).toVar();
    const scour = smoothstep(-0.25, 0.35, noised(p.mul(0.021)).x).mul(0.55).add(0.45);
    const amplitude = mix(float(0.45), float(1), exposure).mul(scour).mul(sastrugiFade).mul(0.125).toVar();
    height.addAssign(crest.x.sub(0.35).mul(amplitude));
    slope.addAssign(fromWind(crest.yz, c, s, along, across).mul(amplitude));
  });

  // Ripples: ~0.42 m transverse corrugation, strongest in the sheltered flats.
  // Veered by half as much, so the two layers do not move as one woven sheet.
  const rippleFade = smoothstep(0.06, 0.3, footprint).oneMinus().mul(strength.y).toVar();
  If(rippleFade.greaterThan(0.001), () => {
    const angle = wind.add(veer.mul(0.5)).toVar();
    const c = angle.cos().toVar();
    const s = angle.sin().toVar();
    const along = 2.9 / 0.42;
    const across = 1 / 0.42;
    const ripple = noised(toWind(p, c, s, along, across)).toVar();
    // Ripples form in fields (~33 m) rather than corrugating every flat; laid
    // evenly they read as a repeating corduroy under the camera.
    const field = smoothstep(-0.15, 0.3, noised(p.mul(0.03).add(vec2(-13.7, 5.3))).x);
    const amplitude = mix(float(1), float(0.45), exposure).mul(field).mul(rippleFade).mul(0.024).toVar();
    height.addAssign(ripple.x.mul(amplitude));
    slope.addAssign(fromWind(ripple.yz, c, s, along, across).mul(amplitude));
  });

  // Grain: ~0.115 m. Too small to see as shape, but it keeps the normal alive
  // right under the camera.
  const grainFade = smoothstep(0.016, 0.08, footprint).oneMinus().mul(strength.z).toVar();
  If(grainFade.greaterThan(0.001), () => {
    const c = wind.cos().toVar();
    const s = wind.sin().toVar();
    const scale = 1 / 0.115;
    const grain = noised(toWind(p, c, s, scale, scale)).toVar();
    const amplitude = grainFade.mul(0.0075);
    height.addAssign(grain.x.mul(amplitude));
    slope.addAssign(fromWind(grain.yz, c, s, scale, scale).mul(amplitude));
  });

  return vec3(height, slope);
}).setLayout({
  name: 'snowFineRelief',
  type: 'vec3',
  inputs: [
    { name: 'p', type: 'vec2' },
    { name: 'wind', type: 'float' },
    { name: 'exposure', type: 'float' },
    { name: 'footprint', type: 'float' },
    { name: 'strength', type: 'vec3' },
  ],
});
