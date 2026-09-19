import * as THREE from 'three';

// World width of one texture tile across a fall, in metres. It is wider than
// the channels that fall, so one fall never repeats a strand side by side.
export const WATERFALL_TILE_WIDTH = 12;

function hash(x, y, seed) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Gradient noise that tiles every `columns` by `rows` lattice cells.
function tiledNoise(columns, rows, seed) {
  const gx = new Float32Array(columns * rows), gy = new Float32Array(columns * rows);
  for (let i = 0; i < gx.length; i += 1) {
    const angle = hash(i % columns, Math.floor(i / columns), seed) * Math.PI * 2;
    gx[i] = Math.cos(angle);
    gy[i] = Math.sin(angle);
  }
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const corner = (cx, cy, dx, dy) => {
      const k = ((cy % rows) + rows) % rows * columns + ((cx % columns) + columns) % columns;
      return gx[k] * dx + gy[k] * dy;
    };
    const a = corner(ix, iy, fx, fy), b = corner(ix + 1, iy, fx - 1, fy);
    const c = corner(ix, iy + 1, fx, fy - 1), d = corner(ix + 1, iy + 1, fx - 1, fy - 1);
    const u = fade(fx);
    return THREE.MathUtils.lerp(a + (b - a) * u, c + (d - c) * u, fade(fy));
  };
}

// Remaps values to their rank, so a channel is evenly spread over 0-1 and a
// foam threshold of 1 - coverage whitens about `coverage` of the fall.
function equalize(values) {
  let min = Infinity, max = -Infinity;
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
  const bins = new Float64Array(2048);
  const scale = (bins.length - 1) / Math.max(max - min, 1e-9);
  for (const value of values) bins[Math.round((value - min) * scale)] += 1;
  let below = 0;
  for (let i = 0; i < bins.length; i += 1) {
    const count = bins[i];
    bins[i] = (below + count * 0.5) / values.length;
    below += count;
  }
  return values.map(value => bins[Math.round((value - min) * scale)]);
}

/**
 * Falling-water detail, u across the fall and v down it, tiling both ways.
 * R: fine strands. G: broader sheets. B: slow patches of thick and thin water.
 * The lattices are far finer across than down, so every channel streaks down
 * the fall; a shared meander keeps the strands off straight lattice columns.
 */
export function createWaterfallTexture({ width = 512, height = 128, seed = 4211 } = {}) {
  const meander = [tiledNoise(6, 2, seed), tiledNoise(12, 3, seed + 1)];
  const strands = [tiledNoise(48, 4, seed + 2), tiledNoise(96, 8, seed + 3)];
  const sheets = [tiledNoise(12, 2, seed + 4), tiledNoise(24, 4, seed + 5)];
  const patches = [tiledNoise(4, 1, seed + 6), tiledNoise(8, 2, seed + 7)];
  const channels = [0, 1, 2].map(() => new Float32Array(width * height));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const u = x / width, v = y / height, k = y * width + x;
    // In units of one strand-lattice cell across (1/48 of the tile).
    const warp = meander[0](u * 6, v * 2) * 1.2 + meander[1](u * 12, v * 3) * 0.45;
    channels[0][k] = strands[0](u * 48 + warp, v * 4) * 0.62 + strands[1](u * 96 + warp * 2, v * 8) * 0.38;
    channels[1][k] = sheets[0](u * 12 + warp / 4, v * 2) * 0.65 + sheets[1](u * 24 + warp / 2, v * 4) * 0.35;
    channels[2][k] = patches[0](u * 4, v) * 0.7 + patches[1](u * 8, v * 2) * 0.3;
  }
  const [r, g, b] = channels.map(equalize);
  const data = new Uint8Array(width * height * 4);
  for (let k = 0; k < width * height; k += 1) {
    data[k * 4] = Math.round(r[k] * 255);
    data[k * 4 + 1] = Math.round(g[k] * 255);
    data[k * 4 + 2] = Math.round(b[k] * 255);
    data[k * 4 + 3] = 255;
  }
  return finishTexture(new THREE.DataTexture(data, width, height), 'Waterfall strands', THREE.RepeatWrapping);
}

/**
 * Soft spray puffs for waterfall mist, a different puff in each channel so a
 * particle picks its shape without atlas bleeding between variants. Each is a
 * round falloff broken up by warped noise, so the edges come out wispy.
 */
export function createSprayPuffTexture({ size = 128, seed = 7723 } = {}) {
  const data = new Uint8Array(size * size * 4);
  for (let channel = 0; channel < 4; channel += 1) {
    const warp = tiledNoise(3, 3, seed + channel * 11);
    const noise = [tiledNoise(4, 4, seed + channel * 11 + 1), tiledNoise(8, 8, seed + channel * 11 + 2),
      tiledNoise(16, 16, seed + channel * 11 + 3)];
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      const bend = warp(u * 3, v * 3) * 0.9;
      const detail = noise[0](u * 4 + bend, v * 4 - bend) * 0.55 + noise[1](u * 8 + bend, v * 8) * 0.3
        + noise[2](u * 16, v * 16 + bend) * 0.15;
      // Radius 1 at the square's inscribed circle; the noise pushes the edge in and out.
      const radius = Math.hypot(u - 0.5, v - 0.5) * 2 * (1 - detail * 0.5);
      const falloff = 1 - THREE.MathUtils.smoothstep(radius, 0.2, 0.95);
      const density = THREE.MathUtils.clamp(falloff * (0.72 + detail * 1.1), 0, 1);
      data[(y * size + x) * 4 + channel] = Math.round(density * 255);
    }
  }
  return finishTexture(new THREE.DataTexture(data, size, size), 'Waterfall spray puffs', THREE.ClampToEdgeWrapping);
}

function finishTexture(result, name, wrap) {
  result.name = name;
  result.wrapS = result.wrapT = wrap;
  result.minFilter = THREE.LinearMipmapLinearFilter;
  result.magFilter = THREE.LinearFilter;
  result.generateMipmaps = true;
  result.anisotropy = 8;
  result.needsUpdate = true;
  return result;
}
