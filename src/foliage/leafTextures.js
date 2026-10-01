import * as THREE from 'three';

// The falling-leaf sprites, painted at startup instead of downloaded: a
// teardrop blade with a soft edge, a midrib, paired side veins and a lit
// upper half, per zone colour. At 256 px each costs a few milliseconds; the
// 1254 px images they replace were ~90 KB each on the wire and 6 MB on the GPU.

const SIZE = 256;

// Colours per zone: base blade, light side, vein. 0-1 sRGB.
export const LEAF_PALETTES = Object.freeze({
  green: { base: [0.16, 0.38, 0.06], light: [0.42, 0.66, 0.16], vein: [0.62, 0.82, 0.3] },
  yellow: { base: [0.62, 0.42, 0.06], light: [0.92, 0.74, 0.2], vein: [0.98, 0.86, 0.46] },
  white: { base: [0.72, 0.72, 0.64], light: [0.96, 0.95, 0.9], vein: [0.86, 0.84, 0.74] },
});

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// Half-width of the blade at height t (0 at the stem, 1 at the tip): a round
// belly low down that narrows to a point.
const halfWidth = (t) => (t <= 0 || t >= 1 ? 0 : 0.36 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.9) * (1 - 0.25 * t));

/** RGBA texels (Uint8Array, SIZE x SIZE, row 0 at the bottom) of one leaf. */
export function paintLeaf({ base, light, vein }, seed = 1) {
  const data = new Uint8Array(SIZE * SIZE * 4);
  let s = seed >>> 0;
  const random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const jitter = Array.from({ length: 16 }, () => random());
  const edgeSoftness = 2.2 / SIZE;
  for (let y = 0; y < SIZE; y += 1) {
    // Blade from v = 0.06 (stem end) to v = 0.96 (tip).
    const t = ((y + 0.5) / SIZE - 0.06) / 0.9;
    const w = halfWidth(t);
    for (let x = 0; x < SIZE; x += 1) {
      const u = (x + 0.5) / SIZE - 0.5;
      const i = (y * SIZE + x) * 4;
      const across = w > 0 ? Math.abs(u) / w : 2;
      const alpha = w > 0 ? smooth(w + edgeSoftness, w - edgeSoftness, Math.abs(u)) : 0;
      // A stub of stem below the blade.
      const stem = t < 0.02 && t > -0.06 ? smooth(0.012, 0.006, Math.abs(u)) : 0;
      if (alpha <= 0 && stem <= 0) { data[i + 3] = 0; continue; }
      // Side veins leave the midrib pointing toward the tip.
      // ...curving toward the rim.
      const veinPhase = t - Math.pow(Math.abs(u) / 0.36, 0.8) * 0.33;
      const veinLine = Math.abs(((veinPhase * 7 + jitter[u < 0 ? 0 : 1] * 0.3) % 1 + 1) % 1 - 0.5);
      const veins = smooth(0.07, 0.015, veinLine) * smooth(0.9, 0.3, across) * smooth(0.02, 0.12, t) * 0.3;
      const midrib = smooth(0.014, 0.004, Math.abs(u)) * smooth(1, 0.75, t) * 0.75;
      // Lit on one side of the fold, darker at the rim and near the stem.
      const side = u < 0 ? 0.85 : 0.6;
      const lit = side * (1 - across * 0.45) * mix(0.75, 1, smooth(0, 0.35, t));
      const rim = smooth(0.6, 1, across) * 0.35;
      // Soft blotches: three sine waves at unrelated angles and scales.
      const mottle = 0.95 + 0.017 * (Math.sin(x * 0.083 + y * 0.051 + jitter[2] * 6)
        + Math.sin(x * -0.047 + y * 0.109 + jitter[3] * 6) + Math.sin(x * 0.131 - y * 0.029 + jitter[4] * 6));
      const vein_ = Math.max(veins, midrib);
      for (let k = 0; k < 3; k += 1) {
        const blade = mix(base[k], light[k], lit) * (1 - rim) * mottle;
        data[i + k] = clamp01(mix(blade, vein[k], vein_)) * 255 + 0.5;
      }
      if (stem > alpha) for (let k = 0; k < 3; k += 1) data[i + k] = base[k] * 0.8 * 255;
      data[i + 3] = Math.max(alpha, stem) * 255 + 0.5;
    }
  }
  return data;
}

/** A mipmapped sRGB texture of one zone's leaf. */
export function createLeafTexture(zone) {
  const palette = LEAF_PALETTES[zone];
  if (!palette) return null;
  const texture = new THREE.DataTexture(paintLeaf(palette, zone.length * 7919), SIZE, SIZE);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
