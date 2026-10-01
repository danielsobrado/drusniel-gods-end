import { Fn, color, dot, float, floor, fract, mix, smoothstep, texture, vec2, vec3, vec4 } from 'three/tsl';
import { hash21, hash22 } from './snowNoiseNodes.js';

const TAU = Math.PI * 2;

/**
 * Terrain curvature from the heightfield normal texture: the divergence of
 * the normal across `step` metres, negated, so it is positive in hollows and
 * gullies and negative on ridges and edges (as the snow accumulation reads
 * it). Four taps of a texture the terrain already binds; zero outside the
 * heightfield. `world` is the world XZ node.
 */
export function heightfieldCurvature(terrainSampler, world, step) {
  const normalTexture = terrainSampler?.normalTexture;
  if (!normalTexture || !(terrainSampler.size?.x > 0) || !(terrainSampler.size?.z > 0)) return null;
  const min = terrainSampler.bounds.min;
  const heightfieldUv = world.sub(vec2(min.x, min.z)).div(vec2(terrainSampler.size.x, terrainSampler.size.z));
  const inside = heightfieldUv.x.greaterThanEqual(0).and(heightfieldUv.x.lessThanEqual(1))
    .and(heightfieldUv.y.greaterThanEqual(0)).and(heightfieldUv.y.lessThanEqual(1));
  const du = vec2(step / terrainSampler.size.x, 0);
  const dv = vec2(0, step / terrainSampler.size.z);
  const normalAt = (offset) => texture(normalTexture, heightfieldUv.add(offset).clamp(0, 1)).xyz.mul(2).sub(1).normalize();
  const divergence = normalAt(du).x.sub(normalAt(du.negate()).x)
    .add(normalAt(dv).z.sub(normalAt(dv.negate()).z)).div(step * 2);
  return inside.select(divergence.negate(), float(0)).toVar();
}

/**
 * Height-based blend of a layer over a base: through the transition the
 * layer takes the places where its own height stands above the base's, so
 * rock breaks through grass on its raised grains and snow settles into the
 * cracks, instead of the two cross-fading. `mask` is the plain 0..1 blend;
 * heights are 0..1 nodes (texture luminance works). At mask 0 and 1 the
 * result is unchanged. `strength` (a uniform) fades back to the plain mask.
 * `width` may be a node (wider far off, where texture heights flatten under
 * mipmapping); `noise` (optional, about -1..1) roughens the edge at scales
 * the textures no longer resolve.
 */
export function heightBlend(mask, baseHeight, layerHeight, { contrast, width, strength, noise = null }) {
  const transition = mask.mul(mask.oneMinus()).mul(4);
  const relief = noise ? layerHeight.add(noise.mul(0.35)) : layerHeight;
  const shifted = mask.add(relief.sub(baseHeight).mul(contrast).mul(transition));
  const halfWidth = float(width);
  const sharp = smoothstep(float(0.5).sub(halfWidth), float(0.5).add(halfWidth), shifted)
    // Keep the ends exact: nothing appears where the mask is 0.
    .mul(smoothstep(0, 0.08, mask)).max(smoothstep(0.92, 1, mask));
  return mix(mask, sharp, strength).clamp(0, 1);
}

/**
 * Rounded stones on a cell grid (Voronoi-style, 3x3 search). `p` is in cell
 * units; `density` the share of cells holding a stone. Returns
 * vec4(r2, id, slopeX, slopeZ) for the nearest stone: r2 is the squared
 * distance from its centre in radii (below 1 inside it; its crown height is
 * 1 - r2, and sqrt(r2) just past 1 gives a contact ring), id a 0..1 hash for
 * its colour, and slope the outward tilt of its dome in the cell's XZ.
 */
export const pebbleField = Fn(([p, density]) => {
  const cell = floor(p);
  const f = fract(p);
  const best = vec4(16, 0, 0, 0).toVar();
  for (let j = -1; j <= 1; j += 1) {
    for (let i = -1; i <= 1; i += 1) {
      const neighbour = cell.add(vec2(i, j));
      const jitter = hash22(neighbour);
      const id = hash21(neighbour.add(vec2(17.31, -9.7)));
      const center = vec2(i, j).add(jitter.mul(0.56).add(0.22));
      const offset = f.sub(center);
      // An elongated, turned oval per stone.
      const angle = id.mul(TAU * 3.7);
      const c = angle.cos();
      const s = angle.sin();
      const turned = vec2(offset.x.mul(c).add(offset.y.mul(s)), offset.y.mul(c).sub(offset.x.mul(s)));
      const radius = hash21(neighbour.add(vec2(-4.2, 31.9))).mul(0.16).add(0.26);
      const scaled = turned.div(vec2(radius.mul(id.mul(0.55).add(1)), radius));
      // Empty cells are pushed out of reach. Presence has its own hash, so
      // the density does not also pick the colours.
      const present = hash21(neighbour.add(vec2(5.3, 71.1))).lessThan(density);
      const r2 = present.select(dot(scaled, scaled), float(16));
      best.assign(r2.lessThan(best.x).select(vec4(r2, id, offset.div(radius)), best));
    }
  }
  return best;
}).setLayout({
  name: 'surfacePebbleField',
  type: 'vec4',
  inputs: [{ name: 'p', type: 'vec2' }, { name: 'density', type: 'float' }],
});

/** A stone's colour from its id: dark basalt, grey granite, ochre and white quartz. */
export function pebbleColor(id, palette = ['#3d3b38', '#7a766f', '#8a6d4c', '#cbc3b3']) {
  const [basalt, granite, ochre, quartz] = palette.map((value) => color(value));
  const tone = fract(id.mul(7.13)).mul(0.3).add(0.85);
  return id.lessThan(0.3).select(basalt, id.lessThan(0.65).select(granite, id.lessThan(0.85).select(ochre, quartz)))
    .mul(tone);
}

/** Luminance of a colour node, as a 0..1 height stand-in. */
export function luminance(rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}
