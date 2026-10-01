// Procedural, seamlessly tiling surfaces for the village houses: albedo plus a
// normal map derived from the same height field, generated in memory at load
// (nothing is downloaded). Pure typed-array code with no three.js import, so
// it runs in a worker (houseTexture.worker.js) as well as on the main thread.
// Every generator works on a square that wraps, so textures tile without
// seams. Rows run with v: row 0 is v = 0, the bottom of a wall or the eave of
// a roof. The per-texel callbacks allocate nothing: they run 65k-262k times.

// World size in metres one texture repeat covers; the house kit divides its
// metre UVs by these.
export const TEXTURE_METRES = Object.freeze({
  stone: 2, darkStone: 2, plaster: 3, wood: 1.5, planks: 2, roofTiles: 2, roofSlate: 2, window: 0.6, deck: 2,
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tileable value-noise fbm: each octave is a random lattice of `period` cells
// that wraps, and the period doubles per octave, so every octave wraps at the
// texture edge. u, v in [0, 1) is one texture repeat.
function makeFbm(random, basePeriod, octaves) {
  const layers = [], periods = [];
  for (let o = 0; o < octaves; o += 1) {
    const period = basePeriod << o;
    const values = new Float32Array(period * period);
    for (let i = 0; i < values.length; i += 1) values[i] = random();
    periods.push(period);
    layers.push(values);
  }
  let norm = 0;
  for (let o = 0, a = 0.5; o < octaves; o += 1, a *= 0.5) norm += a;
  return (u, v) => {
    let sum = 0, amplitude = 0.5 / norm;
    for (let o = 0; o < octaves; o += 1) {
      const period = periods[o], values = layers[o];
      const x = u * period, y = v * period;
      const xi = x | 0, yi = y | 0;
      const fx = x - xi, fy = y - yi;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const x0 = xi % period, y0 = yi % period;
      const x1 = x0 + 1 === period ? 0 : x0 + 1;
      const r0 = y0 * period, r1 = (y0 + 1 === period ? 0 : y0 + 1) * period;
      const a = values[r0 + x0], b = values[r0 + x1], c = values[r1 + x0], d = values[r1 + x1];
      sum += (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * amplitude;
      amplitude *= 0.5;
    }
    return sum;
  };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const wrap = (x) => x - Math.floor(x);

/**
 * Runs `fn(u, v, out)` for every texel; fn writes r, g, b (0-1 albedo) and
 * height into `out`. Returns RGBA albedo and a tangent-space normal map
 * whose relief is `strength` texels of height per unit height step.
 */
function render(size, strength, fn) {
  const color = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const out = new Float32Array(4);
  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x += 1) {
      fn((x + 0.5) / size, v, out);
      const i = y * size + x;
      color[i * 4] = clamp01(out[0]) * 255 + 0.5;
      color[i * 4 + 1] = clamp01(out[1]) * 255 + 0.5;
      color[i * 4 + 2] = clamp01(out[2]) * 255 + 0.5;
      color[i * 4 + 3] = 255;
      height[i] = out[3];
    }
  }
  const normal = new Uint8Array(size * size * 4);
  const mask = size - 1;
  for (let y = 0; y < size; y += 1) {
    const up = ((y + 1) & mask) * size, down = ((y - 1) & mask) * size, row = y * size;
    for (let x = 0; x < size; x += 1) {
      const dx = (height[row + ((x + 1) & mask)] - height[row + ((x - 1) & mask)]) * strength;
      const dy = (height[up + x] - height[down + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 4);
      const i = (row + x) * 4;
      normal[i] = (-dx * inv * 0.5 + 0.5) * 255 + 0.5;
      normal[i + 1] = (-dy * inv * 0.5 + 0.5) * 255 + 0.5;
      normal[i + 2] = (inv + 0.5) * 255 + 0.5;
      normal[i + 3] = 255;
    }
  }
  return { size, color, normal };
}

// Stone courses: rows of varying height, blocks of varying width with an
// offset per row. The course and block under each texel row/column come from
// lookup tables, and one result object is reused.
function makeCourses(random, rows, minWidth, maxWidth, resolution = 1024) {
  const heights = [];
  for (let r = 0; r < rows; r += 1) heights.push(0.7 + random() * 0.6);
  const total = heights.reduce((a, b) => a + b, 0);
  const courses = [];
  let y = 0;
  for (let r = 0; r < rows; r += 1) {
    const h = heights[r] / total;
    const joints = [];
    let x = random();
    const start = x;
    while (x < start + 1 - minWidth * 1.2) {
      joints.push(wrap(x));
      x += minWidth + random() * (maxWidth - minWidth);
    }
    joints.sort((a, b) => a - b);
    const tints = joints.map(() => random());
    // Block index under each texel column (the block starting at or left of it).
    const blockAt = new Int16Array(resolution);
    for (let i = 0; i < resolution; i += 1) {
      const u = (i + 0.5) / resolution;
      let index = joints.length - 1;
      for (let j = 0; j < joints.length; j += 1) if (u < joints[j]) { index = j - 1; break; }
      blockAt[i] = index < 0 ? joints.length - 1 : index;
    }
    courses.push({ y0: y, y1: y + h, joints, tints, blockAt });
    y += h;
  }
  const courseAt = new Int16Array(resolution);
  for (let i = 0; i < resolution; i += 1) {
    const v = (i + 0.5) / resolution;
    let c = rows - 1;
    for (let r = 0; r < rows; r += 1) if (v < courses[r].y1) { c = r; break; }
    courseAt[i] = c;
  }
  const cell = { edge: 0, tint: 0, du: 0, dv: 0 };
  return (u, v) => {
    const course = courses[courseAt[Math.min(resolution - 1, (v * resolution) | 0)]];
    const { joints, tints } = course;
    const index = course.blockAt[Math.min(resolution - 1, (u * resolution) | 0)];
    const left = joints[index];
    const right = index + 1 < joints.length ? joints[index + 1] : joints[0] + 1;
    const du = wrap(u - left);
    const width = right - left;
    // Distance to the nearest joint, in texture units.
    cell.edge = Math.min(du, width - du, v - course.y0, course.y1 - v);
    cell.tint = tints[index];
    cell.du = du / width;
    cell.dv = (v - course.y0) / (course.y1 - course.y0);
    return cell;
  };
}

function stoneSurface(size, seed, [br, bg, bb], [mr, mg, mb]) {
  const random = mulberry32(seed);
  const cell = makeCourses(random, 9, 0.13, 0.3);
  const grain = makeFbm(random, 8, 5);
  const blotch = makeFbm(random, 3, 3);
  return render(size, 6, (u, v, out) => {
    const c = cell(u, v);
    const n = grain(u, v), b = blotch(u, v);
    const bevel = smooth(0.004, 0.022, c.edge + (n - 0.5) * 0.012);
    // Chipped, rounded block faces: height rises from the joint and wobbles.
    const shade = (0.86 + c.tint * 0.22) * (0.8 + n * 0.35) * (0.85 + b * 0.3);
    const warm = (c.tint - 0.5) * 0.08;
    const joint = 0.8 + n * 0.4, cover = mix(0.35, 1, bevel), course = mix(0.88, 1, smooth(0, 0.5, c.dv));
    out[0] = mix(mr * joint, br * shade * (1 + warm), cover) * course;
    out[1] = mix(mg * joint, bg * shade, cover) * course;
    out[2] = mix(mb * joint, bb * shade * (1 - warm), cover) * course;
    out[3] = bevel * (0.75 + n * 0.35) + (b - 0.5) * 0.15;
  });
}

function plasterSurface(size, seed) {
  const random = mulberry32(seed);
  const large = makeFbm(random, 3, 4);
  const fine = makeFbm(random, 32, 3);
  const stain = makeFbm(random, 5, 4);
  return render(size, 1.5, (u, v, out) => {
    const l = large(u, v), f = fine(u, v), s = stain(u, v);
    // Streaks run down the wall: the stain noise stretched vertically.
    const streak = smooth(0.55, 0.8, stain(u, v * 0.25 + l * 0.2));
    const dirt = smooth(0.5, 0.85, s) * 0.2 + streak * 0.15;
    // Patches where the render fell off show a rougher, darker scratch coat.
    const patch = smooth(0.72, 0.75, l * 0.7 + s * 0.3) * 0.6;
    const shade = (0.9 + (l - 0.5) * 0.18 + (f - 0.5) * 0.12) * mix(1, 0.72, patch);
    out[0] = mix(0.84, 0.52, dirt) * shade;
    out[1] = mix(0.74, 0.44, dirt) * shade;
    out[2] = mix(0.57, 0.34, dirt) * shade;
    out[3] = f * 0.35 + l * 0.2 - patch * 0.25;
  });
}

// Timber: grain runs along u (the length of a beam).
function woodSurface(size, seed, [r, g, b]) {
  const random = mulberry32(seed);
  const warp = makeFbm(random, 4, 4);
  const fine = makeFbm(random, 64, 2);
  const boards = makeFbm(random, 2, 2);
  return render(size, 1.5, (u, v, out) => {
    const w = warp(u, v);
    const rings = Math.sin((v * 22 + w * 5) * Math.PI * 2) * 0.5 + 0.5;
    const streak = fine(u * 0.125, v);
    const shade = 0.72 + rings * 0.18 + (streak - 0.5) * 0.35 + (boards(u, v) - 0.5) * 0.3;
    out[0] = r * shade; out[1] = g * shade; out[2] = b * shade;
    out[3] = rings * 0.3 + streak * 0.5;
  });
}

// Vertical boards (doors, sheds, decks): grain runs along v.
function planksSurface(size, seed, [r, g, b], boardCount) {
  const random = mulberry32(seed);
  const warp = makeFbm(random, 4, 4);
  const fine = makeFbm(random, 64, 2);
  const tints = Array.from({ length: boardCount }, () => random());
  const offsets = Array.from({ length: boardCount }, () => random());
  return render(size, 3, (u, v, out) => {
    const board = Math.floor(u * boardCount);
    const across = u * boardCount - board;
    const gap = smooth(0, 0.06, across) * smooth(0, 0.06, 1 - across);
    const w = warp(u, wrap(v + offsets[board]));
    const rings = Math.sin((across * 3 + w * 4) * Math.PI * 2) * 0.5 + 0.5;
    const streak = fine(u, wrap(v * 0.125 + offsets[board]));
    const shade = (0.7 + tints[board] * 0.35) * (0.8 + rings * 0.12 + (streak - 0.5) * 0.4) * mix(0.25, 1, gap);
    out[0] = r * shade; out[1] = g * shade; out[2] = b * shade;
    out[3] = gap * (0.7 + streak * 0.3);
  });
}

// Clay roof tiles in staggered courses. v runs up the slope, so each course's
// lower edge overlaps (and shades) the course below it.
function roofTilesSurface(size, seed) {
  const random = mulberry32(seed);
  const rows = 10, columns = 10;
  const moss = makeFbm(random, 6, 5);
  const grime = makeFbm(random, 3, 4);
  const streaks = makeFbm(random, 8, 3);
  const fine = makeFbm(random, 32, 3);
  const tints = Float32Array.from({ length: rows * columns }, () => random());
  return render(size, 5, (u, v, out) => {
    const row = Math.floor(v * rows);
    const dv = v * rows - row;
    const shifted = wrap(u + (row % 2) * 0.5 / columns + (tints[row] - 0.5) * 0.02);
    const column = Math.floor(shifted * columns);
    const du = shifted * columns - column;
    const tint = tints[(row * columns + column) % tints.length];
    // Barrel profile across the tile, thickening toward its lower lip.
    const barrel = Math.sin(du * Math.PI);
    const lip = smooth(0, 0.12, dv);
    const shadowBelow = mix(0.45, 1, smooth(0, 0.35, dv));
    const n = fine(u, v), m = moss(u, v), g = grime(u, v);
    // Rain streaks run down the slope: noise stretched along v.
    const streak = streaks(u, v * 0.125);
    const shade = (0.82 + barrel * 0.18) * mix(1, shadowBelow, 0.6) * (0.88 + n * 0.24);
    const dirt = Math.min(0.8, smooth(0.3, 0.75, g) * 0.5 + smooth(0.45, 0.75, streak) * 0.45);
    const mossAmount = smooth(0.66, 0.76, m + (1 - barrel) * 0.06 + n * 0.1) * 0.85;
    const mossShade = 0.7 + barrel * 0.3;
    out[0] = mix(mix(0.36 + tint * 0.08, 0.1, dirt) * shade, (0.22 + n * 0.08) * mossShade, mossAmount);
    out[1] = mix(mix(0.15 + tint * 0.04, 0.08, dirt) * shade, (0.26 + n * 0.08) * mossShade, mossAmount);
    out[2] = mix(mix(0.13 + tint * 0.03, 0.07, dirt) * shade, 0.08 * mossShade, mossAmount);
    out[3] = barrel * 0.5 + (1 - dv) * 0.5 * lip + mossAmount * 0.2 + n * 0.1;
  });
}

// Split slate / wooden shingles: flat rectangles with ragged lower edges.
function roofSlateSurface(size, seed) {
  const random = mulberry32(seed);
  const rows = 12, columns = 8;
  const ragged = makeFbm(random, 64, 2);
  const fine = makeFbm(random, 32, 3);
  const grime = makeFbm(random, 3, 4);
  const tints = Float32Array.from({ length: rows * columns * 2 }, () => random());
  return render(size, 5, (u, v, out) => {
    const row = Math.floor(v * rows);
    const dv = v * rows - row;
    const shifted = wrap(u + (row % 2) * 0.5 / columns + tints[row] * 0.3 / columns);
    const column = Math.floor(shifted * columns);
    const du = shifted * columns - column;
    const tint = tints[(row * columns + column) % tints.length];
    const n = fine(u, v), g = grime(u, v);
    const edge = smooth(0, 0.05 + ragged(u, v) * 0.1, dv) * smooth(0, 0.04, du) * smooth(0, 0.04, 1 - du);
    const shadowBelow = mix(0.5, 1, smooth(0, 0.3, dv));
    const shade = shadowBelow * (0.8 + n * 0.35) * mix(0.35, 1, edge) * (0.8 + g * 0.4);
    const lichen = smooth(0.7, 0.78, g + n * 0.15) * 0.3;
    out[0] = mix(0.2 + tint * 0.07, 0.34, lichen) * shade;
    out[1] = mix(0.19 + tint * 0.05, 0.36, lichen) * shade;
    out[2] = mix(0.19 + tint * 0.04, 0.26, lichen) * shade;
    out[3] = edge * (0.6 + (1 - dv) * 0.4) + n * 0.1;
  });
}

// Leaded lights: dark glass behind a diamond lattice of lead cames.
function windowSurface(size, seed) {
  const random = mulberry32(seed);
  const fine = makeFbm(random, 16, 3);
  return render(size, 1, (u, v, out) => {
    const a = wrap((u + v) * 2), b = wrap((u - v) * 2);
    const lead = Math.min(Math.min(a, 1 - a), Math.min(b, 1 - b));
    const came = smooth(0.02, 0.05, lead);
    const n = fine(u, v);
    // Old glass: a greenish sheen that varies pane to pane.
    const sheen = 0.5 + 0.5 * Math.sin((u * 3 + v * 5 + n) * 2);
    const glass = 0.8 + n * 0.4;
    out[0] = mix(0.08, (0.1 + sheen * 0.08) * glass, came);
    out[1] = mix(0.08, (0.13 + sheen * 0.1) * glass, came);
    out[2] = mix(0.08, (0.14 + sheen * 0.1) * glass, came);
    out[3] = came * 0.3 + n * 0.1;
  });
}

const GENERATORS = {
  stone: () => stoneSurface(512, 11, [0.6, 0.6, 0.6], [0.4, 0.38, 0.36]),
  darkStone: () => stoneSurface(512, 23, [0.27, 0.28, 0.31], [0.15, 0.15, 0.15]),
  plaster: () => plasterSurface(256, 5),
  wood: () => woodSurface(256, 7, [0.36, 0.23, 0.14]),
  planks: () => planksSurface(256, 13, [0.42, 0.29, 0.18], 8),
  deck: () => planksSurface(256, 17, [0.36, 0.26, 0.18], 7),
  roofTiles: () => roofTilesSurface(512, 3),
  roofSlate: () => roofSlateSurface(512, 29),
  window: () => windowSurface(128, 31),
};

export const SURFACE_NAMES = Object.freeze(Object.keys(GENERATORS));

/** RGBA albedo and normal texels of a named surface: { size, color, normal }. */
export function generateSurfaceData(name) {
  return GENERATORS[name]();
}
