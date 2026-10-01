import * as THREE from 'three';
import { TEXTURE_METRES } from './houseTextureData.js';

// A small low-poly building kit in real metres (house frame: origin at the
// footprint centre, y up, ground at 0). Everything is emitted into one
// vertex/index buffer per surface, so a whole house draws in a handful of
// calls. UVs are world metres divided by the surface's texture size, so the
// tiling textures keep one texel density across walls, beams and roofs.
// Vertex colours carry the ambient term the baked originals had in their
// albedo: grime near the ground, dark soffits and per-call tints.

const UP = [0, 1, 0];
// How far foundations reach below a house's ground line: more than the 4-5 m
// the village terrain falls across a footprint.
export const FOUNDATION_DEPTH = 6;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a) => { const l = length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// The in-plane axes a face's texture follows: u horizontal, v up the face
// (up the slope on a roof). Horizontal faces use world x and z.
function faceAxes(normal, uHint) {
  let u = uHint ? normalize(sub(uHint, scale(normal, dot(uHint, normal)))) : cross(UP, normal);
  if (length(u) < 1e-4) u = [1, 0, 0];
  u = normalize(u);
  return { u, v: normalize(cross(normal, u)) };
}

export class HouseBuilder {
  constructor({ seed = 1, grimeHeight = 0, palette = {} } = {}) {
    this.parts = new Map();
    this.grimeHeight = grimeHeight;
    // Per-surface colour multipliers: each house's own shade of stone, roof
    // and timber from the shared generated textures.
    this.palette = palette;
    let a = seed >>> 0;
    this.random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  #part(material) {
    let part = this.parts.get(material);
    if (!part) {
      const tint = this.palette[material] ?? 1;
      part = { positions: [], normals: [], uvs: [], colors: [], indices: [], tint: typeof tint === 'number' ? [tint, tint, tint] : tint };
      this.parts.set(material, part);
    }
    return part;
  }

  // Ambient occlusion baked into the vertex colour: grime rising from the
  // ground and darker faces that look down (soffits, jetty undersides).
  #shade(point, normal, tint, palette) {
    const ground = 0.55 + 0.45 * smooth(0, 1.3, point[1] - this.grimeHeight);
    const facing = normal[1] < -0.3 ? 0.55 : normal[1] > 0.5 ? 1.05 : 1;
    const base = typeof tint === 'number' ? [tint, tint, tint] : tint;
    const s = ground * facing;
    return [base[0] * s * palette[0], base[1] * s * palette[1], base[2] * s * palette[2]];
  }

  #vertex(part, point, normal, uv, tint) {
    part.positions.push(point[0], point[1], point[2]);
    part.normals.push(normal[0], normal[1], normal[2]);
    part.uvs.push(uv[0], uv[1]);
    const c = this.#shade(point, normal, tint, part.tint);
    part.colors.push(c[0], c[1], c[2]);
    return part.positions.length / 3 - 1;
  }

  /**
   * A planar convex polygon (CCW seen from its front), fanned from its first
   * point. UVs project on the face axes in metres / texture size.
   */
  poly(material, points, { tint = 1, uAxis = null, origin = [0, 0, 0], uvOffset = [0, 0], normal = null, facing = null } = {}) {
    const part = this.#part(material);
    // Winding follows the wanted normal (or facing hint), whatever order the
    // caller listed the points in.
    let gn = normalize(cross(sub(points[1], points[0]), sub(points[2], points[0])));
    const want = normal ?? facing;
    if (want && dot(gn, want) < 0) { points = [...points].reverse(); gn = scale(gn, -1); }
    const n = normal ?? gn;
    const { u, v } = faceAxes(n, uAxis);
    const tile = TEXTURE_METRES[material] ?? 1;
    const base = part.positions.length / 3;
    for (const p of points) {
      const d = sub(p, origin);
      this.#vertex(part, p, n, [dot(d, u) / tile + uvOffset[0], dot(d, v) / tile + uvOffset[1]], tint);
    }
    for (let i = 1; i + 1 < points.length; i += 1) part.indices.push(base, base + i, base + i + 1);
  }

  /**
   * A grid surface P(s, t) over the given parameter values, with smooth vertex
   * normals from its partial differences. uv(s, t) returns metres.
   */
  surface(material, fn, sValues, tValues, { uv, tint = 1, facing = null } = {}) {
    const part = this.#part(material);
    const tile = TEXTURE_METRES[material] ?? 1;
    const base = part.positions.length / 3;
    const eps = 1e-3;
    // Flip the whole grid when its natural normal opposes `facing`.
    let flip = false;
    if (facing) {
      const sm = (sValues[0] + sValues[sValues.length - 1]) / 2, tm = (tValues[0] + tValues[tValues.length - 1]) / 2;
      const n = cross(sub(fn(sm + eps, tm), fn(sm - eps, tm)), sub(fn(sm, tm + eps), fn(sm, tm - eps)));
      flip = dot(n, facing) < 0;
    }
    for (const t of tValues) {
      for (const s of sValues) {
        const p = fn(s, t);
        const ds = sub(fn(s + eps, t), fn(s - eps, t));
        const dt = sub(fn(s, t + eps), fn(s, t - eps));
        let n = normalize(cross(ds, dt));
        if (flip) n = scale(n, -1);
        const [mu, mv] = uv(s, t, p);
        this.#vertex(part, p, n, [mu / tile, mv / tile], typeof tint === 'function' ? tint(s, t, p) : tint);
      }
    }
    const row = sValues.length;
    for (let j = 0; j + 1 < tValues.length; j += 1) {
      for (let i = 0; i + 1 < row; i += 1) {
        const a = base + j * row + i, b = a + 1, c = a + row, d = c + 1;
        if (flip) part.indices.push(a, c, b, b, c, d);
        else part.indices.push(a, b, c, b, d, c);
      }
    }
  }

  /** An oriented box: centre, half extents along its own axes (x, y, z). */
  orientedBox(material, centre, axes, half, { tint = 1, faces = 'all', grainAxis = 0 } = {}) {
    const [ax, ay, az] = axes;
    const corner = (sx, sy, sz) => add(add(add(centre, scale(ax, sx * half[0])), scale(ay, sy * half[1])), scale(az, sz * half[2]));
    const grain = axes[grainAxis];
    const normals = { px: ax, nx: scale(ax, -1), py: ay, ny: scale(ay, -1), pz: az, nz: scale(az, -1) };
    const quads = {
      px: [corner(1, -1, 1), corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1)],
      nx: [corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1)],
      py: [corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1), corner(-1, 1, -1)],
      ny: [corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)],
      pz: [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)],
      nz: [corner(1, -1, -1), corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1)],
    };
    for (const [key, points] of Object.entries(quads)) {
      if (faces !== 'all' && !faces.includes(key)) continue;
      const n = normals[key];
      // Grain along the box's long axis unless the face is its end grain.
      const along = Math.abs(dot(n, grain)) > 0.9 ? null : grain;
      this.poly(material, points, { tint, uAxis: along, normal: n, origin: centre });
    }
  }

  /** Axis-aligned box from min to max corners, optionally turned about y. */
  box(material, min, max, { tint = 1, faces = 'all', rotY = 0, pivot = null } = {}) {
    const centre = scale(add(min, max), 0.5);
    const half = scale(sub(max, min), 0.5);
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const axes = [[c, 0, -s], [0, 1, 0], [s, 0, c]];
    let at = centre;
    if (rotY && pivot) {
      const d = sub(centre, pivot);
      at = [pivot[0] + d[0] * c + d[2] * s, centre[1], pivot[2] - d[0] * s + d[2] * c];
    }
    const grainAxis = half[0] >= half[1] && half[0] >= half[2] ? 0 : half[2] >= half[1] ? 2 : 1;
    this.orientedBox(material, at, axes, half, { tint, faces, grainAxis });
  }

  /** A square-section beam from a to b; `side` orients its cross-section. */
  beam(material, a, b, size, { tint = 1, side = null, depth = null } = {}) {
    const dir = normalize(sub(b, a));
    let x = side ? normalize(sub(side, scale(dir, dot(side, dir)))) : cross(dir, Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : UP);
    x = normalize(x);
    const y = cross(dir, x);
    const len = length(sub(b, a));
    this.orientedBox(material, scale(add(a, b), 0.5), [dir, x, y], [len / 2, (depth ?? size) / 2, size / 2], { tint, grainAxis: 0 });
  }

  /** A capped cylinder or cone frustum standing on `base`. */
  cylinder(material, base, radius, height, segments = 6, { topRadius = radius, tint = 1, cap = true } = {}) {
    const ring = (y, r) => Array.from({ length: segments }, (_, i) => {
      const a = (i / segments) * Math.PI * 2;
      return [base[0] + Math.cos(a) * r, base[1] + y, base[2] + Math.sin(a) * r];
    });
    const bottom = ring(0, radius), top = ring(height, topRadius);
    for (let i = 0; i < segments; i += 1) {
      const j = (i + 1) % segments;
      const out = [Math.cos(((i + 0.5) / segments) * Math.PI * 2), 0, Math.sin(((i + 0.5) / segments) * Math.PI * 2)];
      if (topRadius > 0) this.poly(material, [bottom[j], bottom[i], top[i], top[j]], { tint, facing: out });
      else this.poly(material, [bottom[j], bottom[i], top[i]], { tint, facing: out });
    }
    if (cap && topRadius > 0) this.poly(material, top, { tint, facing: UP });
  }

  // ---------------------------------------------------------------- walls

  /**
   * Four walls of a rectangular storey. Returns the wall descriptors (front
   * +z, right +x, back -z, left -x) for placing windows, frames and doors.
   * `cuts` are extra horizontal splits so the ground grime has vertices.
   */
  walls(material, { x0, x1, z0, z1, y0, y1, tint = 1, skip = [], topShade = 0.7 }) {
    const walls = [
      { name: 'front', a: [x0, z1], b: [x1, z1], normal: [0, 0, 1] },
      { name: 'right', a: [x1, z1], b: [x1, z0], normal: [1, 0, 0] },
      { name: 'back', a: [x1, z0], b: [x0, z0], normal: [0, 0, -1] },
      { name: 'left', a: [x0, z0], b: [x0, z1], normal: [-1, 0, 0] },
    ].map((w) => ({ ...w, y0, y1, length: Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]), dir: normalize([w.b[0] - w.a[0], 0, w.b[1] - w.a[1]]) }));
    const ys = [y0];
    for (const cut of [this.grimeHeight + 0.4, this.grimeHeight + 1.3, y1 - topShade]) if (cut > y0 + 0.1 && cut < y1 - 0.1) ys.push(cut);
    ys.push(y1);
    ys.sort((a, b) => a - b);
    // The wall darkens toward its head (shadowed under eaves and jetties).
    const shade = (s, t) => {
      const k = topShade ? 1 - 0.35 * smooth(y1 - topShade, y1, t) : 1;
      return typeof tint === 'number' ? tint * k : tint.map((c) => c * k);
    };
    for (const w of walls) {
      if (skip.includes(w.name)) continue;
      this.surface(material, (s, t) => [w.a[0] + (w.b[0] - w.a[0]) * s, t, w.a[1] + (w.b[1] - w.a[1]) * s], [0, 1], ys, {
        uv: (s, t, p) => [dot(p, w.dir), t], tint: shade,
      });
    }
    return Object.fromEntries(walls.map((w) => [w.name, w]));
  }

  /** A wall descriptor from its start (x, z), outward normal and length. */
  wall(a, normal, length, y0 = 0, y1 = 0) {
    const n = normalize(normal);
    return { a, normal: n, dir: cross(UP, n), length, y0, y1 };
  }

  /**
   * The foundation under a storey: its walls continued `depth` metres below
   * `top` (the design's ground line). On a slope the house stands level at
   * the uphill ground and this plinth fills the drop on the downhill side;
   * the rest stays under the terrain.
   */
  plinth(material, { x0, x1, z0, z1, top = 0, depth = FOUNDATION_DEPTH, tint = 1 }) {
    return this.walls(material, { x0, x1, z0, z1, y0: top - depth, y1: top + 0.02, tint, topShade: 0 });
  }

  /** A point on a wall: `u` metres along it, height `y`, `d` metres out. */
  at(wall, u, y, d = 0) {
    return [wall.a[0] + wall.dir[0] * u + wall.normal[0] * d, y, wall.a[1] + wall.dir[2] * u + wall.normal[2] * d];
  }

  /** A flat panel on a wall face (window glass, door leaves, signs). */
  panel(material, wall, u0, u1, y0, y1, d, { tint = 1, origin = null } = {}) {
    const o = origin ?? this.at(wall, u0, y0, d);
    this.poly(material, [this.at(wall, u0, y0, d), this.at(wall, u1, y0, d), this.at(wall, u1, y1, d), this.at(wall, u0, y1, d)], { tint, origin: o, normal: wall.normal });
  }

  /** A beam lying on a wall face between two (u, y) points. */
  wallBeam(wall, u0, y0, u1, y1, size = 0.2, { material = 'wood', d = 0.06, tint = 1 } = {}) {
    const n = [wall.normal[0], 0, wall.normal[2]];
    this.beam(material, this.at(wall, u0, y0, d), this.at(wall, u1, y1, d), size, { side: n, depth: size * 0.7, tint });
  }

  /**
   * Half-timbering on a wall band: sill and head rails, posts every
   * `spacing` metres, and braces in the bays that have no window.
   */
  timberFrame(wall, { y0, y1, spacing = 1.6, rails = [], braces = 'diagonal', openings = [], size = 0.2, tint = 1, inset = 0 }) {
    const L = wall.length;
    this.wallBeam(wall, -size / 2 + inset, y0, L + size / 2 - inset, y0, size, { tint });
    this.wallBeam(wall, -size / 2 + inset, y1, L + size / 2 - inset, y1, size, { tint });
    for (const y of rails) this.wallBeam(wall, inset, y, L - inset, y, size * 0.8, { tint });
    const bays = Math.max(1, Math.round((L - 2 * inset) / spacing));
    const step = (L - 2 * inset) / bays;
    for (let i = 0; i <= bays; i += 1) this.wallBeam(wall, inset + i * step, y0, inset + i * step, y1, size, { tint });
    if (braces === 'none') return;
    for (let i = 0; i < bays; i += 1) {
      const u0 = inset + i * step, u1 = u0 + step;
      if (openings.some(([a, b]) => a < u1 - 0.05 && b > u0 + 0.05)) continue;
      const flip = braces === 'cross' || (braces === 'diagonal' && (i < bays / 2));
      if (braces === 'cross') {
        this.wallBeam(wall, u0, y0, u1, y1, size * 0.8, { tint, d: 0.05 });
        this.wallBeam(wall, u0, y1, u1, y0, size * 0.8, { tint, d: 0.07 });
      } else if (flip) this.wallBeam(wall, u0, y0, u1, y1, size * 0.8, { tint });
      else this.wallBeam(wall, u0, y1, u1, y0, size * 0.8, { tint });
    }
  }

  /** A leaded window with a timber frame, sill and optional shutters. */
  window(wall, u, y, w, h, { frame = 'wood', mullion = true, sill = true, tint = 1, shutters = false, arch = false } = {}) {
    const u0 = u - w / 2, u1 = u + w / 2;
    // The glass sits just proud of the wall, so no hole is cut.
    this.panel('window', wall, u0, u1, y, y + h, 0.03, { tint });
    if (arch) {
      this.stoneArch(wall, u, y, w, h);
      return;
    }
    const f = 0.12;
    this.wallBeam(wall, u0 - f / 2, y + h, u1 + f / 2, y + h, f, { material: frame, d: 0.07, tint });
    this.wallBeam(wall, u0, y, u0, y + h, f, { material: frame, d: 0.07, tint });
    this.wallBeam(wall, u1, y, u1, y + h, f, { material: frame, d: 0.07, tint });
    if (mullion) this.wallBeam(wall, u, y, u, y + h, f * 0.6, { material: frame, d: 0.06, tint });
    if (sill) this.wallBeam(wall, u0 - 0.12, y - 0.04, u1 + 0.12, y - 0.04, 0.12, { material: frame, d: 0.1, tint });
    if (shutters) {
      this.panel('planks', wall, u0 - w * 0.5 - 0.05, u0 - 0.07, y, y + h, 0.09, { tint: 0.8 });
      this.panel('planks', wall, u1 + 0.07, u1 + w * 0.5 + 0.05, y, y + h, 0.09, { tint: 0.8 });
    }
  }

  /** Voussoirs around a round-headed opening, in the light stone. */
  stoneArch(wall, u, y, w, h, { material = 'stone', blocks = 7, tint = 1.35 } = {}) {
    const r = w / 2, spring = y + h - r;
    const t = 0.22;
    for (let i = 0; i < blocks; i += 1) {
      const a0 = Math.PI - (i / blocks) * Math.PI, a1 = Math.PI - ((i + 1) / blocks) * Math.PI;
      const am = (a0 + a1) / 2;
      const inner = [u + Math.cos(am) * (r + t / 2), spring + Math.sin(am) * (r + t / 2)];
      const half = (r + t) * Math.sin((a0 - a1) / 2) * 0.92;
      const tangent = [-Math.sin(am), Math.cos(am)];
      this.wallBeam(wall, inner[0] - tangent[0] * half, inner[1] - tangent[1] * half, inner[0] + tangent[0] * half, inner[1] + tangent[1] * half, t, { material, d: 0.08, tint: tint * (0.9 + this.random() * 0.2) });
    }
    // Jambs down to the sill.
    for (const side of [-1, 1]) {
      for (let yy = y; yy < spring - 0.05; yy += 0.36) {
        const top = Math.min(spring, yy + 0.32);
        const off = (Math.floor((yy - y) / 0.36) % 2) * 0.06;
        this.wallBeam(wall, u + side * (r + t / 2 + off / 2), yy, u + side * (r + t / 2 + off / 2), top, t + off, { material, d: 0.08, tint: tint * (0.9 + this.random() * 0.2) });
      }
    }
    if (h > r) this.panel('window', wall, u - r, u + r, spring, spring + r * 0.98, 0.03);
  }

  /** A plank door, optionally round-headed in a stone arch. */
  door(wall, u, w, h, { arch = false, y = 0, tint = 0.85 } = {}) {
    const u0 = u - w / 2, u1 = u + w / 2;
    const top = arch ? y + h - w / 2 : y + h;
    this.panel('planks', wall, u0, u1, y, top, 0.04, { tint });
    if (arch) {
      // A fan of plank wedges fills the round head.
      const r = w / 2, segs = 5;
      for (let i = 0; i < segs; i += 1) {
        const a0 = Math.PI * (i / segs), a1 = Math.PI * ((i + 1) / segs);
        this.poly('planks', [this.at(wall, u, top, 0.04), this.at(wall, u + Math.cos(a0) * r, top + Math.sin(a0) * r, 0.04), this.at(wall, u + Math.cos(a1) * r, top + Math.sin(a1) * r, 0.04)], { tint, normal: wall.normal });
      }
      this.stoneArch(wall, u, y, w, h, { blocks: 7 });
      return;
    }
    const f = 0.16;
    this.wallBeam(wall, u0 - f, top + f / 2, u1 + f, top + f / 2, f, { d: 0.08 });
    this.wallBeam(wall, u0 - f / 2, y, u0 - f / 2, top, f, { d: 0.08 });
    this.wallBeam(wall, u1 + f / 2, y, u1 + f / 2, top, f, { d: 0.08 });
    // Ledges across the leaf.
    this.wallBeam(wall, u0, y + 0.35, u1, y + 0.35, 0.1, { material: 'planks', d: 0.07, tint: tint * 0.8 });
    this.wallBeam(wall, u0, top - 0.35, u1, top - 0.35, 0.1, { material: 'planks', d: 0.07, tint: tint * 0.8 });
  }

  /** Alternating long-and-short dressed stones up a wall corner. */
  quoins(wall, end, y0, y1, { material = 'stone', course = 0.42, tint = 1.1, d = 0.05 } = {}) {
    const u = end === 'start' ? 0 : wall.length;
    const inward = end === 'start' ? 1 : -1;
    let i = 0;
    for (let y = y0; y + 0.1 < y1; y += course, i += 1) {
      const long = i % 2 === 0 ? 0.7 : 0.42;
      const top = Math.min(y1, y + course - 0.04);
      const a = this.at(wall, u - inward * 0.05, y, d), b = this.at(wall, u + inward * long, top, d);
      this.box(material, [Math.min(a[0], b[0]) - (wall.normal[0] ? 0.06 : 0), y, Math.min(a[2], b[2]) - (wall.normal[2] ? 0.06 : 0)],
        [Math.max(a[0], b[0]) + (wall.normal[0] ? 0.06 : 0), top, Math.max(a[2], b[2]) + (wall.normal[2] ? 0.06 : 0)], { tint: tint * (0.85 + this.random() * 0.3) });
    }
  }

  /** Joist ends projecting under a jetty or eave, along a wall. */
  joists(wall, y, { spacing = 0.8, out = 0.45, size = 0.18, tint = 1, material = 'wood' } = {}) {
    const n = Math.max(1, Math.round(wall.length / spacing));
    for (let i = 0; i <= n; i += 1) {
      const u = (i / n) * wall.length;
      this.beam(material, this.at(wall, u, y, -0.1), this.at(wall, u, y, out), size, { tint, side: UP });
    }
  }

  // ---------------------------------------------------------------- roofs

  /**
   * A gable roof over the rectangle x0..x1, z0..z1 with its ridge along
   * `axis`. The roof passes `wallTop` at the wall line and rises to `ridgeY`.
   * `sweep` < 1 curves the slopes (steep at the ridge, flat at the eaves);
   * `sag` dips the ridge between its ends. Gable ends are filled down to
   * wallTop with `gableMaterial` unless listed in `openEnds`.
   */
  gableRoof({
    x0, x1, z0, z1, axis = 'z', wallTop, ridgeY, overhang = 0.5, endOverhang = 0.4, thickness = 0.22,
    sweep = 1, sag = 0, material = 'roofTiles', gableMaterial = 'plaster', gableTint = 1, openEnds = [],
    segments = null, lengthSegments = null, tint = 1, ridgeBeam = true, purlins = 2, gableFrame = false, gableInset = 0,
    rafterTails = 0.8, hips = [0, 0],
  }) {
    // Local frame: `a` across the ridge, `b` along it.
    const alongZ = axis === 'z';
    const ca = alongZ ? (x0 + x1) / 2 : (z0 + z1) / 2;
    const halfIn = alongZ ? (x1 - x0) / 2 : (z1 - z0) / 2;
    const b0 = (alongZ ? z0 : x0) - endOverhang, b1 = (alongZ ? z1 : x1) + endOverhang;
    const halfOut = halfIn + overhang;
    const rise = ridgeY - wallTop;
    const drop = (d) => rise * Math.pow(Math.abs(d) / halfIn, sweep);
    const ridgeAt = (b) => {
      if (!sag) return ridgeY;
      const k = ((b - b0) / (b1 - b0)) * 2 - 1;
      return ridgeY - sag * (1 - k * k);
    };
    // Surface height at signed offset d from the ridge, position b along it.
    const heightAt = (d, b = (b0 + b1) / 2) => ridgeAt(b) - drop(d) * (ridgeAt(b) - wallTop) / rise;
    const point = (a, y, b) => (alongZ ? [ca + a, y, b] : [b, y, ca + a]);
    const nSeg = segments ?? (sweep === 1 ? 1 : 5);
    const nLen = lengthSegments ?? (sag ? 6 : 1);
    const ts = Array.from({ length: nSeg + 1 }, (_, i) => i / nSeg);
    const bs = Array.from({ length: nLen + 1 }, (_, i) => b0 + ((b1 - b0) * i) / nLen);
    // Arc length up the slope from the eave, for tile rows that follow it.
    const arc = (() => {
      const samples = 64, table = [0];
      let prev = [halfOut, heightAt(halfOut)];
      for (let i = 1; i <= samples; i += 1) {
        const d = halfOut * (1 - i / samples);
        const next = [d, heightAt(d)];
        table.push(table[i - 1] + Math.hypot(next[0] - prev[0], next[1] - prev[1]));
        prev = next;
      }
      return (t) => { const f = t * samples, i = Math.min(samples - 1, Math.floor(f)); return table[i] + (table[i + 1] - table[i]) * (f - i); };
    })();
    const roofTint = (s, t) => { const k = 0.78 + 0.22 * t; return typeof tint === 'number' ? tint * k : tint.map((c) => c * k); };
    // Hipped ends pull the ridge in: at height t a side slope spans
    // bAt(0, t)..bAt(1, t), and each hip is a triangle down to its eave.
    const bAt = (s, t) => (b0 + hips[0] * t) + ((b1 - hips[1] * t) - (b0 + hips[0] * t)) * s;
    for (const side of [1, -1]) {
      // t: 0 at the eave, 1 at the ridge. s runs along the ridge.
      const top = (s, t) => { const d = side * halfOut * (1 - t); const b = bAt(s, t); return point(d, heightAt(d, b), b); };
      const under = (s, t) => { const p = top(s, t); return [p[0], p[1] - thickness, p[2]]; };
      const sVals = bs.map((b) => (b - b0) / (b1 - b0));
      this.surface(material, top, sVals, ts, { uv: (s, t) => [bAt(s, t) * side, arc(t)], tint: roofTint, facing: UP });
      this.surface('planks', under, sVals, ts, { uv: (s, t) => [bAt(s, t), arc(t)], tint: 0.7, facing: [0, -1, 0] });
      // Eave edge and the two verge edges.
      const out = alongZ ? [side, 0, 0] : [0, 0, side];
      const eave = sVals.map((s) => [top(s, 0), under(s, 0)]);
      for (let i = 0; i + 1 < eave.length; i += 1) {
        this.poly('wood', [eave[i][1], eave[i + 1][1], eave[i + 1][0], eave[i][0]], { tint: 0.8, facing: out });
      }
      for (const [s, dir] of [[0, -1], [1, 1]]) {
        if (hips[s]) continue;
        for (let j = 0; j < nSeg; j += 1) {
          this.poly('wood', [under(s, ts[j]), under(s, ts[j + 1]), top(s, ts[j + 1]), top(s, ts[j])], { tint: 0.75, facing: alongZ ? [0, 0, dir] : [dir, 0, 0] });
        }
      }
    }
    for (const [end, dir] of [[0, -1], [1, 1]]) {
      if (!hips[end]) continue;
      const bEnd = end ? b1 : b0;
      const hipTop = (s, t) => {
        const d = halfOut * (1 - t);
        const b = bEnd - dir * hips[end] * t;
        return point((s * 2 - 1) * d, heightAt(d, b), b);
      };
      const hipUnder = (s, t) => { const p = hipTop(s, t); return [p[0], p[1] - thickness, p[2]]; };
      const out = alongZ ? [0, 0, dir] : [dir, 0, 0];
      const ratio = hips[end] / halfOut;
      this.surface(material, hipTop, [0, 0.5, 1], ts, { uv: (s, t, p) => [(alongZ ? p[0] : p[2]), arc(t) * ratio], tint: roofTint, facing: UP });
      this.surface('planks', hipUnder, [0, 1], ts, { uv: (s, t, p) => [(alongZ ? p[0] : p[2]), arc(t) * ratio], tint: 0.7, facing: [0, -1, 0] });
      this.poly('wood', [hipUnder(0, 0), hipUnder(1, 0), hipTop(1, 0), hipTop(0, 0)], { tint: 0.8, facing: out });
    }
    if (ridgeBeam) {
      const r0 = b0 + hips[0], r1 = b1 - hips[1];
      const rs = bs.map((b) => r0 + ((b - b0) / (b1 - b0)) * (r1 - r0));
      for (let i = 0; i + 1 < rs.length; i += 1) {
        this.beam('wood', point(0, ridgeAt(rs[i]) + 0.04, rs[i] - (i === 0 && !hips[0] ? 0.15 : 0)), point(0, ridgeAt(rs[i + 1]) + 0.04, rs[i + 1] + (i + 2 === rs.length && !hips[1] ? 0.15 : 0)), 0.24, { side: UP, tint: 0.75 });
      }
    }
    // Rafter tails under the eaves, from the wall line out to the fascia.
    if (rafterTails) {
      const bIn0 = alongZ ? z0 : x0, bIn1 = alongZ ? z1 : x1;
      const n = Math.max(1, Math.round((bIn1 - bIn0) / rafterTails));
      for (const side of [1, -1]) {
        for (let i = 0; i <= n; i += 1) {
          const b = bIn0 + ((bIn1 - bIn0) * i) / n;
          const dIn = side * (halfIn - 0.15), dOut = side * (halfOut - 0.05);
          const a = point(dIn, heightAt(dIn, b) - thickness - 0.08, b), c = point(dOut, heightAt(dOut, b) - thickness - 0.08, b);
          this.beam('wood', a, c, 0.12, { side: UP, tint: 0.7 });
        }
      }
    }
    // Purlin ends poke out of the gables under the roof.
    for (let i = 1; i <= (hips[0] || hips[1] ? 0 : purlins); i += 1) {
      for (const side of [1, -1]) {
        const d = side * halfIn * (i / (purlins + 1)) * 1.6;
        if (Math.abs(d) > halfOut - 0.1) continue;
        const y = heightAt(d) - thickness - 0.12;
        this.beam('wood', point(d, y, b0 - 0.35), point(d, y, b1 + 0.35), 0.16, { side: UP, tint: 0.7 });
      }
    }
    // Gable ends, fanned from the middle of the wall top (the region under
    // the profile is star-shaped from there even when the slopes are swept).
    const ends = [['start', alongZ ? z0 : x0, -1], ['end', alongZ ? z1 : x1, 1]];
    for (const [name, b, dir] of ends) {
      if (openEnds.includes(name) || hips[name === 'start' ? 0 : 1]) continue;
      const bb = b + dir * gableInset;
      const n = alongZ ? [0, 0, dir] : [dir, 0, 0];
      const outline = [];
      const steps = sweep === 1 ? 1 : 8;
      for (let i = 0; i <= steps; i += 1) outline.push(-halfIn + (halfIn * i) / steps);
      for (let i = 1; i <= steps; i += 1) outline.push((halfIn * i) / steps);
      const pts = outline.map((d) => point(d, heightAt(d, bb) - thickness, bb));
      const centre = point(0, wallTop - thickness, bb);
      const base = [point(halfIn, wallTop - thickness, bb), ...pts.reverse(), point(-halfIn, wallTop - thickness, bb)];
      for (let i = 0; i + 1 < base.length; i += 1) this.poly(gableMaterial, [centre, base[i], base[i + 1]], { tint: gableTint, normal: n, origin: [0, 0, 0] });
      if (gableFrame === true || (Array.isArray(gableFrame) && gableFrame.includes(name))) {
        const middle = point(0, 0, bb);
        const dirU = cross(UP, n);
        const wall = this.wall([middle[0] - dirU[0] * halfIn, middle[2] - dirU[2] * halfIn], n, halfIn * 2);
        const topY = heightAt(0, bb) - thickness;
        const collar = wallTop - thickness + (topY - wallTop) * 0.45;
        this.wallBeam(wall, halfIn, wallTop - thickness, halfIn, topY - 0.05, 0.2);
        const reach = (y) => { let d = halfIn; for (let k = 0; k < 20; k += 1) { d = halfIn * Math.pow(Math.max(0, (ridgeAt(bb) - y - thickness) / rise), 1 / sweep); } return d; };
        const w = reach(collar);
        this.wallBeam(wall, halfIn - w, collar, halfIn + w, collar, 0.18);
        this.wallBeam(wall, halfIn - w * 0.85, collar, halfIn - 0.1, topY - (topY - collar) * 0.35, 0.16);
        this.wallBeam(wall, halfIn + w * 0.85, collar, halfIn + 0.1, topY - (topY - collar) * 0.35, 0.16);
      }
    }
    return { heightAt: (d, b) => heightAt(d, b ?? (b0 + b1) / 2), ridgeAt, b0, b1, ca, halfIn, halfOut, alongZ, point };
  }

  /** Iron spikes along a ridge, with a sagging wire strung between them. */
  ridgeSpikes(roof, { count = 5, height = 1.1, wire = true, from = 0.05, to = 0.95 } = {}) {
    const tips = [];
    for (let i = 0; i < count; i += 1) {
      const b = roof.b0 + (roof.b1 - roof.b0) * (from + ((to - from) * i) / Math.max(1, count - 1));
      const y = roof.ridgeAt(b) + 0.1;
      const base = roof.point(0, y, b);
      const h = height * (0.85 + this.random() * 0.3);
      this.beam('metal', base, add(base, [0, h, 0]), 0.05);
      this.cylinder('metal', add(base, [0, h, 0]), 0.07, 0.28, 4, { topRadius: 0 });
      this.beam('metal', add(base, [-0.12, h * 0.8, 0]), add(base, [0.12, h * 0.8, 0]), 0.03);
      tips.push(add(base, [0, h * 0.7, 0]));
    }
    if (!wire) return;
    for (let i = 0; i + 1 < tips.length; i += 1) {
      const a = tips[i], b = tips[i + 1];
      const mid = add(lerp3(a, b, 0.5), [0, -0.25, 0]);
      this.beam('metal', a, mid, 0.025);
      this.beam('metal', mid, b, 0.025);
    }
  }

  /** A stone chimney stack with a cap slab and clay pots. */
  chimney({ x, z, w = 0.9, d = 0.9, y0, y1, material = 'stone', pots = 2, tint = 1, capTint = 0.8 }) {
    this.box(material, [x - w / 2, y0, z - d / 2], [x + w / 2, y1, z + d / 2], { tint, faces: ['px', 'nx', 'pz', 'nz'] });
    this.box(material, [x - w / 2 - 0.12, y1, z - d / 2 - 0.12], [x + w / 2 + 0.12, y1 + 0.18, z + d / 2 + 0.12], { tint: capTint });
    for (let i = 0; i < pots; i += 1) {
      const px = pots === 1 ? x : x - w / 4 + (w / 2) * (i / (pots - 1));
      this.cylinder('metal', [px, y1 + 0.18, z], 0.13, 0.35 + (i % 2) * 0.15, 6, { tint: 1.3 });
    }
  }

  /** A dormer on a roof slope facing `facing` (+x, -x, +z, -z). */
  dormer(roof, { at, offset, w = 1.1, h = 1.1, facing, material = 'plaster', roofMaterial = 'roofTiles', tint = 1 }) {
    // `offset`: distance of the dormer face from the ridge line; `at`:
    // position along the ridge.
    const sign = facing.startsWith('-') ? -1 : 1;
    const base = roof.heightAt(sign * offset, at) - 0.2;
    const depth = offset;
    const alongZ = roof.alongZ;
    const faceA = sign * offset;
    const backA = sign * Math.max(0.2, offset - depth);
    const pa = (a, y, b) => roof.point(a, y, b);
    const lo = Math.min(faceA, backA), hi = Math.max(faceA, backA);
    const min = pa(lo, base, at - w / 2), max = pa(hi, base + h, at + w / 2);
    this.box(material, [Math.min(min[0], max[0]), base, Math.min(min[2], max[2])], [Math.max(min[0], max[0]), base + h, Math.max(min[2], max[2])], { tint, faces: ['px', 'nx', 'pz', 'nz'] });
    const n = alongZ ? [sign, 0, 0] : [0, 0, sign];
    const centre = pa(faceA, 0, at);
    const dirU = cross(UP, n);
    const wall = this.wall([centre[0] - dirU[0] * w / 2, centre[2] - dirU[2] * w / 2], n, w);
    this.window(wall, w / 2, base + 0.2, w * 0.55, h * 0.6, { sill: false, mullion: false });
    // Its own little gable roof, ridge running back into the main slope.
    const rMin = pa(lo, 0, at - w / 2), rMax = pa(hi, 0, at + w / 2);
    this.gableRoof({
      x0: Math.min(rMin[0], rMax[0]), x1: Math.max(rMin[0], rMax[0]), z0: Math.min(rMin[2], rMax[2]), z1: Math.max(rMin[2], rMax[2]),
      axis: alongZ ? 'x' : 'z', wallTop: base + h, ridgeY: base + h + w * 0.55, overhang: 0.15, endOverhang: 0.15,
      thickness: 0.1, material: roofMaterial, gableMaterial: material, openEnds: [sign > 0 ? 'start' : 'end'], ridgeBeam: false, purlins: 0,
    });
  }

  /** A straight run of steps rising from `from` to `to` (x, z, y). */
  stairs(material, from, to, width, steps, { tint = 1, solid = true } = {}) {
    const dir = normalize([to[0] - from[0], 0, to[2] - from[2]]);
    const side = [dir[2], 0, -dir[0]];
    const run = Math.hypot(to[0] - from[0], to[2] - from[2]) / steps;
    const riseStep = (to[1] - from[1]) / steps;
    for (let i = 0; i < steps; i += 1) {
      const c = add(from, add(scale(dir, run * (i + 0.5)), [0, 0, 0]));
      const yTop = from[1] + riseStep * (i + 1);
      const yBottom = solid ? from[1] - 0.2 : yTop - riseStep - 0.1;
      this.orientedBox(material, [c[0], (yTop + yBottom) / 2, c[2]], [dir, UP, side], [run / 2 + 0.02, (yTop - yBottom) / 2, width / 2], { tint: tint * (0.9 + this.random() * 0.2) });
    }
  }

  /** A hanging sign on an iron bracket, out from a wall. */
  sign(wall, u, y, { out = 1.1 } = {}) {
    const root = this.at(wall, u, y, 0.05), tip = this.at(wall, u, y, out);
    this.beam('metal', root, tip, 0.05);
    this.beam('metal', this.at(wall, u, y - 0.4, 0.05), this.at(wall, u, y, out * 0.6), 0.04);
    const c = this.at(wall, u, y - 0.55, out * 0.75);
    const across = normalize(cross(UP, [wall.normal[0], 0, wall.normal[2]]));
    this.orientedBox('planks', c, [[wall.normal[0], 0, wall.normal[2]], UP, across], [0.3, 0.4, 0.04], { tint: 0.9 });
  }

  /**
   * Geometry per surface, as meshes sharing the given material map, shifted
   * by `offset` (the frame the house is placed in).
   */
  build(materials, offset = [0, 0, 0]) {
    const group = new THREE.Group();
    for (const [name, part] of this.parts) {
      if (!part.indices.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(part.normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(part.uvs, 2));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(part.colors, 3));
      const count = part.positions.length / 3;
      geometry.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(part.indices, 1) : new THREE.Uint16BufferAttribute(part.indices, 1));
      if (offset[0] || offset[1] || offset[2]) geometry.translate(offset[0], offset[1], offset[2]);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, materials[name]);
      mesh.name = name;
      group.add(mesh);
    }
    return group;
  }
}
