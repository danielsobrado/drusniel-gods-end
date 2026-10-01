import { SERPENT_EYE_THETA, SERPENT_MOUTH_THETA, sampleStations, smoothstep } from './serpentShape.js';

// Procedural skin for the giant serpents, generated once at load. Two maps:
//
// Scale tile (tiles both ways, linear): overlapping diamond scales, 16 across
// and 16 along (32 staggered half-rows). RG = tangent-space normal xy,
// B = crevice occlusion, A = a random value per scale.
//
// Body pattern (sRGB, whole body): a species coat (reticulated python,
// green anaconda or king cobra) laid out in scale units, u around the body
// (0 on the spine, 0.5 on the belly) and v in scale rows from the snout, so
// its markings shrink with the girth exactly as the scales do. RGB = colour, A = belly (ventral plates) mask.

function hash(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function mod(value, period) {
  return ((value % period) + period) % period;
}

// Value noise in [-1, 1] whose lattice wraps every `periodX` cells in x.
function valueNoise(x, y, periodX, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const x0 = mod(ix, periodX), x1 = mod(ix + 1, periodX);
  const a = hash(x0, iy, seed), b = hash(x1, iy, seed);
  const c = hash(x0, iy + 1, seed), d = hash(x1, iy + 1, seed);
  return ((a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy) * 2 - 1;
}

function fbm(x, y, periodX, seed, octaves = 3) {
  let sum = 0, amplitude = 0.5, total = 0, frequency = 1;
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += valueNoise(x * frequency, y * frequency, periodX * frequency, seed + octave * 101) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}

/**
 * Overlapping scales, `columns` across by `rows` staggered half-rows along
 * (even, so the stagger tiles; a diamond spans two, so 2 * columns rows make
 * them as long as they are wide). Each scale is a rounded diamond whose
 * surface rises from its buried front edge to a free rear edge (toward the
 * tail, +v) that drops into the crevice before the next scale.
 */
export function createScaleTileData({ size = 512, columns = 16, rows = 32, seed = 7331 } = {}) {
  const heights = new Float32Array(size * size);
  const occlusion = new Float32Array(size * size);
  const ids = new Float32Array(size * size);
  const jitter = (i, j, axis) => hash(mod(i, columns), mod(j, rows), seed + axis) - 0.5;
  for (let py = 0; py < size; py += 1) {
    const Y = ((py + 0.5) / size) * rows;
    const jy = Math.floor(Y);
    for (let px = 0; px < size; px += 1) {
      const X = ((px + 0.5) / size) * columns;
      let d1 = Infinity, d2 = Infinity, bestDx = 0, bestDy = 0, bestId = 0;
      for (let j = jy - 2; j <= jy + 2; j += 1) {
        const offset = (mod(j, 2)) * 0.5;
        const ix = Math.floor(X - offset);
        for (let i = ix - 1; i <= ix + 2; i += 1) {
          const cx = i + offset + 0.5 + jitter(i, j, 1) * 0.2;
          const cy = j + 0.5 + jitter(i, j, 2) * 0.18;
          const dx = X - cx, dy = Y - cy;
          // Diamond metric (staggered neighbours sit at (+-0.5, +-1) and
          // (+-1, 0)), rounded a little toward Euclidean at the corners.
          const l1 = Math.abs(dx) + Math.abs(dy) * 0.5;
          const l2 = Math.hypot(dx, dy * 0.5) * 1.18;
          const d = l1 * 0.72 + l2 * 0.28;
          if (d < d1) {
            d2 = d1;
            d1 = d;
            bestDx = dx;
            bestDy = dy;
            bestId = hash(mod(i, columns), mod(j, rows), seed + 3);
          } else if (d < d2) d2 = d;
        }
      }
      const edge = d2 - d1;
      const k = py * size + px;
      // Rises toward the free rear edge (dy > 0), domed across.
      const along = Math.max(-1, Math.min(1, bestDy));
      const across = Math.min(1, Math.abs(bestDx) / 0.5);
      const dome = 0.55 + 0.3 * (along * 0.5 + 0.5) - 0.25 * across * across;
      // The rear edge falls away sharply; the front and flanks are softer.
      const lip = bestDy > 0 ? smoothstep(0, 0.07, edge) : smoothstep(0, 0.16, edge);
      heights[k] = dome * lip + (hash(px, py, seed + 9) - 0.5) * 0.015;
      occlusion[k] = 0.3 + 0.7 * smoothstep(0, 0.2, edge);
      ids[k] = bestId;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const strength = size / columns / 7;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const k = py * size + px;
      const left = heights[py * size + mod(px - 1, size)];
      const right = heights[py * size + mod(px + 1, size)];
      const down = heights[mod(py - 1, size) * size + px];
      const up = heights[mod(py + 1, size) * size + px];
      let nx = -(right - left) * 0.5 * strength;
      let ny = -(up - down) * 0.5 * strength;
      const length = Math.hypot(nx, ny, 1);
      nx /= length;
      ny /= length;
      data[k * 4] = Math.round((nx * 0.5 + 0.5) * 255);
      data[k * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[k * 4 + 2] = Math.round(occlusion[k] * 255);
      data[k * 4 + 3] = Math.round(ids[k] * 255);
    }
  }
  return { data, width: size, height: size };
}

const hex = value => [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(channel => channel / 255);

function mixColor(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

function mixInto(out, b, t) {
  return mixColor(out, out, b, t);
}

// Nearest and second-nearest seed among `lanes` of seeds repeating every
// `period` rows along the body, on the cylinder (x wraps at rowsAround).
function nearestSeeds(wx, wy, lanes, period, context, stretch, out) {
  const { rowsAround, half, seed } = context;
  let f1 = Infinity, f2 = Infinity, kind = 0;
  const k0 = Math.floor(wy / period);
  for (let k = k0 - 1; k <= k0 + 1; k += 1) {
    for (let lane = 0; lane < lanes.length; lane += 1) {
      const spec = lanes[lane];
      const sx = spec.x + (hash(k, lane, seed + 1) - 0.5) * (spec.jitterX ?? 3);
      const sy = (k + spec.phase) * period + (hash(k, lane, seed + 2) - 0.5) * period * (spec.jitterY ?? 0.3);
      const dx = (mod(wx - sx + half, rowsAround) - half) * stretch[0];
      const dy = (wy - sy) * stretch[1];
      const d = Math.hypot(dx, dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        kind = spec.kind;
      } else if (d < f2) f2 = d;
    }
  }
  out.f1 = f1;
  out.f2 = f2;
  out.kind = kind;
  return out;
}

// Reticulated python: a gold network edged in black around dark dorsal
// saddles, with pale lilac eye-spots along the lower flanks.
function reticulatedCoat(p, context, color, tmp) {
  const { palette, rowsAround } = context;
  const lanes = context.lanes ??= [
    { x: 0, phase: 0, kind: 0 },
    { x: rowsAround * 0.17, phase: 0.5, kind: 1 },
    { x: -rowsAround * 0.17, phase: 0.5, kind: 1 },
    { x: rowsAround * 0.33, phase: 0.05, kind: 2 },
    { x: -rowsAround * 0.33, phase: 0.05, kind: 2 },
  ];
  const { f1, f2, kind } = nearestSeeds(p.wx, p.wy, lanes, rowsAround * 0.38, context, [1.05, 0.85], context.seeds);
  const edge = (f2 - f1) * 0.5;
  const lineNoise = p.lineNoise;
  const lineWidth = 0.55 + lineNoise;
  const goldWidth = lineWidth + 1.5 + lineNoise * 2;
  if (kind === 0) {
    mixColor(color, palette.saddle, palette.dorsal, smoothstep(1.5, 6, f1) * 0.7);
    // The dark line down the middle of the back, through each saddle.
    if (p.absX < 0.5 + lineNoise) mixInto(color, palette.line, 0.8 * smoothstep(1, 3, edge));
  } else if (kind === 1) {
    mixColor(color, palette.dorsal, palette.lateral, 0.55 + smoothstep(2, 5, f1) * 0.3);
  } else {
    mixColor(color, palette.lateral, palette.saddle, smoothstep(2, 6, f1) * 0.5);
    const spot = 1 - smoothstep(1.4, 2.1, f1 + lineNoise * 2);
    const ring = smoothstep(1.6, 2.2, f1) * (1 - smoothstep(2.4, 3.2, f1));
    mixInto(color, palette.spotRing, ring * 0.85);
    mixInto(color, palette.spot, spot * 0.9);
  }
  if (edge < goldWidth) {
    const band = smoothstep(lineWidth, lineWidth + 0.35, edge);
    mixColor(tmp, palette.goldDeep, palette.gold, smoothstep(lineWidth, goldWidth * 0.8, edge));
    mixInto(color, tmp, 1 - smoothstep(goldWidth - 0.4, goldWidth, edge));
    mixInto(color, palette.line, 1 - band);
  }
}

// Green anaconda: olive, with big black ovals in two alternating rows down
// the back and black rings with yellow-orange centres along the flanks.
function anacondaCoat(p, context, color, tmp) {
  const { palette, rowsAround } = context;
  const period = rowsAround * 0.32;
  const dorsal = context.dorsal ??= [
    { x: rowsAround * 0.075, phase: 0, kind: 0, jitterX: 1.5 },
    { x: -rowsAround * 0.075, phase: 0.5, kind: 0, jitterX: 1.5 },
  ];
  const lateral = context.lateral ??= [
    { x: rowsAround * 0.22, phase: 0.25, kind: 1, jitterX: 2 },
    { x: -rowsAround * 0.22, phase: 0.75, kind: 1, jitterX: 2 },
    { x: rowsAround * 0.31, phase: 0.75, kind: 1, jitterX: 2 },
    { x: -rowsAround * 0.31, phase: 0.25, kind: 1, jitterX: 2 },
  ];
  mixColor(color, palette.base, palette.baseLight, fbm(p.X / 4, p.Y / 4, rowsAround / 4, context.seed + 5) * 0.5 + 0.5);
  mixInto(color, palette.flank, smoothstep(rowsAround * 0.12, rowsAround * 0.36, p.absX) * 0.6);
  const edgeNoise = p.lineNoise * 2;
  const { f1: spotDistance } = nearestSeeds(p.wx, p.wy, dorsal, period, context, [1, 0.72], context.seeds);
  const spotRadius = rowsAround * 0.058;
  mixInto(color, palette.spot, 1 - smoothstep(spotRadius - 0.5, spotRadius + 0.3, spotDistance + edgeNoise));
  const { f1: ringDistance } = nearestSeeds(p.wx, p.wy, lateral, period, context, [1, 0.8], context.seeds);
  const ringRadius = rowsAround * 0.042;
  const ring = smoothstep(ringRadius - 1.1, ringRadius - 0.7, ringDistance + edgeNoise)
    * (1 - smoothstep(ringRadius, ringRadius + 0.45, ringDistance + edgeNoise));
  const eye = 1 - smoothstep(ringRadius - 1.3, ringRadius - 0.9, ringDistance + edgeNoise);
  mixColor(tmp, palette.ocellus, palette.ocellusDeep, smoothstep(0, ringRadius - 1, ringDistance));
  mixInto(color, tmp, eye * 0.95);
  mixInto(color, palette.spot, ring);
}

// King cobra: dark olive shading to black at the tail, crossed by pale
// chevrons that point toward the head, strongest over the front of the body.
function cobraCoat(p, context, color) {
  const { palette, rowsAround, shape } = context;
  const along = p.s / shape.length;
  mixColor(color, palette.front, palette.base, smoothstep(0.05, 0.45, along));
  mixInto(color, palette.tail, smoothstep(0.55, 0.95, along));
  mixInto(color, palette.base, (fbm(p.X / 3, p.Y / 3, rowsAround / 3, context.seed + 5) * 0.5 + 0.5) * 0.25);
  const period = rowsAround * 0.6;
  const chevron = (p.wy - p.absX * 0.9) / period;
  const offset = Math.abs(chevron - Math.floor(chevron) - 0.5);
  const width = 0.085 - along * 0.035 + p.lineNoise * 0.08;
  const band = (1 - smoothstep(width, width + 0.03, offset))
    * (1 - smoothstep(rowsAround * 0.3, rowsAround * 0.4, p.absX))
    * (0.95 - along * 0.35);
  mixInto(color, along < 0.4 ? palette.band : palette.bandPale, Math.max(0, band));
}

const SKINS = Object.freeze({
  reticulated: {
    coat: reticulatedCoat,
    bellyEdge: 0.4,
    palette: {
      line: hex(0x16110b), gold: hex(0xd3a847), goldDeep: hex(0x8f6a26), dorsal: hex(0x6d6446), saddle: hex(0x3f3524),
      lateral: hex(0x7b5c37), spot: hex(0xe2d9cb), spotRing: hex(0x2c2117), belly: hex(0xe7d9b0),
      bellySpeck: hex(0x9d8a60), head: hex(0x8d7c4b), headMottle: hex(0x3f3524), headDark: hex(0x221910),
      lip: hex(0xe6d8ab),
    },
    head: { midline: true, stripe: 'headDark', pits: true },
    bellySpeck: 0.45,
  },
  anaconda: {
    coat: anacondaCoat,
    bellyEdge: 0.42,
    palette: {
      base: hex(0x4e5a26), baseLight: hex(0x68722f), flank: hex(0x7a7a34), spot: hex(0x121209),
      ocellus: hex(0xe0a531), ocellusDeep: hex(0xb4691d), belly: hex(0xd9c66e), bellySpeck: hex(0x16140b),
      head: hex(0x56602a), headMottle: hex(0x2b3014), headDark: hex(0x131309), lip: hex(0xc8b965),
      stripe: hex(0xd9772a),
    },
    // Orange stripe from the eye to the jaw, bordered in black.
    head: { midline: true, stripe: 'stripe', stripeBorder: true },
    // Bold black blotches on the yellow belly, not flecks.
    bellySpeck: 0.95,
    bellyScale: 0.4,
  },
  cobra: {
    coat: cobraCoat,
    bellyEdge: 0.36,
    palette: {
      front: hex(0x5a5430), base: hex(0x2f2c1c), tail: hex(0x16140e), band: hex(0xd8cd86), bandPale: hex(0xcbc6a4),
      belly: hex(0xe0d49a), bellySpeck: hex(0x6a6450), head: hex(0x5d5330), headMottle: hex(0x3a331d),
      headDark: hex(0x1e1a10), lip: hex(0xe3d7a0), crownBand: hex(0xd4c98a),
    },
    // Two pale bands across the back of the crown instead of a stripe.
    head: { crownBands: true },
    bellySpeck: 0.3,
    // The belly darkens toward the tail.
    bellyDarkens: true,
  },
});


// Texture size of the coat, known before the worker has drawn it.
export function serpentPatternSize(shape, totalRows, { texelsPerScale = 4, maxHeight = 4096 } = {}) {
  return {
    width: Math.max(64, Math.round(shape.scaleRows * texelsPerScale)),
    height: Math.max(64, Math.min(maxHeight, Math.round(totalRows * texelsPerScale))),
  };
}

/**
 * The coat of `species` at `texelsPerScale` texels per scale unit.
 * `stations` and `scaleCoordinates` map scale rows back to metres for the
 * head and tail markings.
 */
export function createSerpentPatternData({
  shape, stations, scaleCoordinates, species = 'reticulated', texelsPerScale = 4, maxHeight = 4096, seed = 9127,
} = {}) {
  const skin = SKINS[species] ?? SKINS.reticulated;
  const palette = skin.palette;
  const rowsAround = shape.scaleRows;
  const totalRows = scaleCoordinates[scaleCoordinates.length - 1];
  const { width, height } = serpentPatternSize(shape, totalRows, { texelsPerScale, maxHeight });
  const data = new Uint8Array(width * height * 4);
  const half = rowsAround / 2;
  const context = { palette, rowsAround, half, seed, shape, seeds: { f1: 0, f2: 0, kind: 0 } };
  const { headLength, neck, length } = shape;
  // Eye and jaw corner, in scale units around, for the stripe behind the eye.
  const eyeX = (SERPENT_EYE_THETA / (Math.PI * 2)) * rowsAround;
  const jawX = (SERPENT_MOUTH_THETA / (Math.PI * 2)) * rowsAround;
  const labial = headLength * 0.052;
  const color = [0, 0, 0];
  const tmp = [0, 0, 0];
  const pixel = { X: 0, Y: 0, absX: 0, s: 0, wx: 0, wy: 0, lineNoise: 0 };
  for (let py = 0; py < height; py += 1) {
    const Y = ((py + 0.5) / height) * totalRows;
    const s = sampleStations(scaleCoordinates, stations, Y);
    const headWeight = 1 - smoothstep(headLength * 0.9, neck + headLength * 0.28, s);
    const tailT = smoothstep(shape.vent, length, s);
    for (let px = 0; px < width; px += 1) {
      // Signed around coordinate: 0 on the spine, +-half on the belly.
      let X = ((px + 0.5) / width) * rowsAround;
      if (X > half) X -= rowsAround;
      const absX = Math.abs(X);
      pixel.X = X;
      pixel.Y = Y;
      pixel.absX = absX;
      pixel.s = s;
      pixel.wx = X + fbm(X / 6, Y / 6, rowsAround / 6, seed + 11) * 2.4;
      pixel.wy = Y + fbm(X / 6 + 17.3, Y / 6, rowsAround / 6, seed + 23) * 2.8;
      pixel.lineNoise = fbm(X / 2.5, Y / 2.5, rowsAround / 2.5, seed + 31) * 0.25;
      skin.coat(pixel, context, color, tmp);
      // Belly: pale, flecked or blotched.
      const bellyEdge = rowsAround * skin.bellyEdge + fbm(Y / 3, X / 3, 1e6, seed + 41) * 1.6;
      const belly = smoothstep(bellyEdge - 1, bellyEdge + 1.2, absX);
      if (belly > 0) {
        const bellyScale = skin.bellyScale ?? 1.3;
        // A whole number of lattice cells around, so the flecks wrap without a seam.
        const cellsAround = Math.max(1, Math.round(rowsAround * bellyScale));
        const fleck = smoothstep(0.45, 0.85,
          valueNoise(X * cellsAround / rowsAround, Y * bellyScale, cellsAround, seed + 51));
        mixColor(tmp, palette.belly, palette.bellySpeck, fleck * skin.bellySpeck);
        if (skin.bellyDarkens) mixInto(tmp, palette.bellySpeck, smoothstep(0.35, 0.8, s / length) * 0.7);
        mixInto(color, tmp, belly);
      }
      if (headWeight > 0) {
        const t = s / headLength;
        const style = skin.head;
        mixColor(tmp, palette.head, palette.headMottle,
          (fbm(X / 1.5, Y / 1.5, rowsAround / 1.5, seed + 61) * 0.5 + 0.5) * 0.35);
        if (style.midline && t > 0.18 && absX < 0.5) mixInto(tmp, palette.headDark, 0.85);
        if (style.stripe && t > 0.26) {
          // From the eye back and down to the jaw corner.
          const stripeX = eyeX + (jawX - eyeX) * smoothstep(0.26, 1.15, t);
          const across = Math.abs(absX - stripeX);
          if (style.stripeBorder) mixInto(tmp, palette.headDark, (1 - smoothstep(1.1, 1.6, across)) * 0.9);
          mixInto(tmp, palette[style.stripe], (1 - smoothstep(0.6, 1.2, across)) * 0.95);
        }
        if (style.crownBands) {
          const band = Math.min(Math.abs(t - 0.78), Math.abs(t - 1.02));
          mixInto(tmp, palette.crownBand, (1 - smoothstep(0.03, 0.06, band)) * (1 - smoothstep(jawX - 3, jawX, absX)) * 0.9);
        }
        mixInto(tmp, palette.lip, smoothstep(jawX - 1 + t * 0.8, jawX + 0.4 + t * 0.8, absX));
        if (t < 0.85 && absX > jawX - 2.4 && absX < jawX + 0.6) {
          // One labial scale every ~5% of the head: a dark bar and, on
          // pythons, a heat pit.
          const bar = Math.abs(mod(s, labial) / labial - 0.5);
          mixInto(tmp, palette.headDark, (1 - smoothstep(0.08, 0.16, bar)) * 0.55);
          if (style.pits && t > 0.12) {
            const pit = Math.hypot(absX - (jawX - 1.2), (mod(s, labial) / labial - 0.5) * 2.25);
            mixInto(tmp, palette.headDark, (1 - smoothstep(0.35, 0.6, pit)) * 0.9);
          }
        }
        mixInto(color, tmp, headWeight);
      }
      // Darker tail; slow mottling everywhere.
      const shade = (1 - tailT * 0.28) * (1 + fbm(X / 9, Y / 9, rowsAround / 9, seed + 71) * 0.1);
      const warm = fbm(X / 14 + 5, Y / 14, rowsAround / 14, seed + 81) * 0.05;
      const k = (py * width + px) * 4;
      data[k] = Math.round(Math.min(1, color[0] * shade * (1 + warm)) * 255);
      data[k + 1] = Math.round(Math.min(1, color[1] * shade) * 255);
      data[k + 2] = Math.round(Math.min(1, color[2] * shade * (1 - warm)) * 255);
      data[k + 3] = Math.round(belly * 255);
    }
  }
  return { data, width, height, totalRows };
}
