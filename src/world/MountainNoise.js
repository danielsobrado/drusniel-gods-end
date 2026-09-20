import { hash2d } from '../grass/vegetationEcology.js';

// Octaves are rotated against each other (about 37 degrees) so no ridge or
// valley lines up with the noise lattice.
const ROTATE_COS = 0.8;
const ROTATE_SIN = 0.6;

/**
 * 2D gradient noise with analytic derivatives: [value, d/dx, d/dz]. Value is
 * roughly in [-0.7, 0.7]. Unlike value noise, its ridges run in any direction
 * instead of along the lattice axes.
 */
export function gradientNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const du = 30 * fx * fx * (fx * (fx - 2) + 1);
  const dv = 30 * fz * fz * (fz * (fz - 2) + 1);
  const angle = (i, j) => hash2d(ix + i, iz + j, seed) * Math.PI * 2;
  const a = angle(0, 0), b = angle(1, 0), c = angle(0, 1), d = angle(1, 1);
  const gax = Math.cos(a), gaz = Math.sin(a), gbx = Math.cos(b), gbz = Math.sin(b);
  const gcx = Math.cos(c), gcz = Math.sin(c), gdx = Math.cos(d), gdz = Math.sin(d);
  const va = gax * fx + gaz * fz;
  const vb = gbx * (fx - 1) + gbz * fz;
  const vc = gcx * fx + gcz * (fz - 1);
  const vd = gdx * (fx - 1) + gdz * (fz - 1);
  const k = va - vb - vc + vd;
  return [
    va + u * (vb - va) + v * (vc - va) + u * v * k,
    gax + u * (gbx - gax) + v * (gcx - gax) + u * v * (gax - gbx - gcx + gdx) + du * (vb - va + v * k),
    gaz + u * (gbz - gaz) + v * (gcz - gaz) + u * v * (gaz - gbz - gcz + gdz) + dv * (vc - va + u * k),
  ];
}

/**
 * Mountain relief in about [0, 1]: a ridged multifractal whose finer octaves
 * are weighted by the coarser ridge, so arêtes stay sharp and crested with
 * detail while the valleys between them are smooth. Each octave is also
 * damped by the slope gathered so far, the way erosion leaves steep flanks
 * cut by gullies and gentle ground plain.
 *
 * Octave n has a wavelength of 1/2.03^n in the coordinates passed in. Octaves
 * shorter than about eight times the terrain mesh's grid step cannot be drawn:
 * they only turn into facets and a crest that zig-zags from vertex to vertex,
 * so callers over a coarse mesh pass a smaller `octaves`.
 */
export function mountainRelief(x, z, seed, octaves = 5) {
  let px = x, pz = z;
  let total = 0, norm = 0, amplitude = 1, weight = 1, slopeX = 0, slopeZ = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const [value, dx, dz] = gradientNoise(px, pz, seed + octave * 131);
    const ridge = Math.max(0, 1 - Math.abs(value) * 1.6);
    const crest = ridge * ridge;
    slopeX += dx * amplitude * weight;
    slopeZ += dz * amplitude * weight;
    total += crest * amplitude * weight / (1 + (slopeX * slopeX + slopeZ * slopeZ) * 0.35);
    norm += amplitude;
    weight = Math.min(1, crest * 1.4);
    amplitude *= 0.48;
    const rx = (px * ROTATE_COS - pz * ROTATE_SIN) * 2.03;
    pz = (px * ROTATE_SIN + pz * ROTATE_COS) * 2.03;
    px = rx;
  }
  return total / norm;
}
