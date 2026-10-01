// Body plan of the jungle serpent, shared by its geometry and its skin
// textures. Distances are metres along the body from the snout tip (s = 0) to
// the tail tip (s = length). Pure maths, no three.js, so it runs in tests.

const DEFAULT_SHAPE = Object.freeze({
  length: 260,
  // Half-width of the body at its thickest.
  radius: 5,
  // Half-height over half-width: the body is a loaf, a little wider than tall.
  heightRatio: 0.84,
  headLength: 14.5,
  headWidth: 4.4,
  headHeight: 2.7,
  // Dorsal scale rows around the body. Real snakes keep a near constant count
  // from neck to tail, so scales shrink with the girth toward the tail.
  scaleRows: 64,
});

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

// Where the eyes and the mouth line sit around the head (radians from the
// spine toward either side); the skin paints its head stripe from them.
export const SERPENT_EYE_THETA = 1.0;
export const SERPENT_MOUTH_THETA = 1.8;

export function resolveSerpentShape(options = {}) {
  const shape = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SHAPE)) shape[key] = finiteOr(options[key], fallback);
  shape.headLength = Math.min(shape.headLength, shape.length * 0.2);
  // Where the neck is narrowest, where the body reaches full girth and where
  // the tail starts to taper (the vent).
  shape.neck = shape.headLength + shape.headWidth * 0.8;
  shape.shoulder = Math.max(shape.neck + 1, shape.length * 0.16);
  shape.vent = shape.length * 0.78;
  return Object.freeze(shape);
}

export function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Half-width and half-height of the cross-section at `s`. The head is a
 * flattened wedge: a rounded snout, widest at the jaw hinges, then a pinched
 * neck that swells into the body; the tail tapers to a point past the vent.
 */
export function serpentSection(s, shape, target = { w: 0, h: 0 }) {
  const { length, radius, heightRatio, headLength, headWidth, headHeight, neck, shoulder, vent } = shape;
  if (s <= 0 || s >= length) {
    target.w = 0;
    target.h = 0;
    return target;
  }
  const t = s / headLength;
  // Rounded snout: a quarter ellipse over the first 11% of the head.
  const nose = Math.sqrt(Math.max(0, 1 - (1 - Math.min(1, t / 0.11)) ** 2));
  // Head outline from above: a wedge from a narrow snout to the wide jaw
  // hinges at 80%.
  const jaw = lerp(0.4, 1, smoothstep(0, 0.8, t) ** 0.8);
  const headW = headWidth * nose * jaw;
  const headH = headHeight * nose * lerp(0.5, 1, smoothstep(0, 0.75, t));
  // Body girth: pinched neck, full body, tapered tail.
  const neckW = headWidth * 0.66;
  const bodyW = radius * (1 + 0.05 * Math.sin(Math.PI * Math.min(1, s / vent)));
  let w = s < neck
    ? lerp(headW, neckW, smoothstep(headLength * 0.78, neck, s))
    : lerp(neckW, bodyW, smoothstep(neck, shoulder, s));
  let h = s < neck
    ? lerp(headH, neckW * 0.9, smoothstep(headLength * 0.8, neck, s))
    : lerp(neckW * 0.9, bodyW * heightRatio, smoothstep(neck, shoulder, s));
  if (s > vent) {
    const tail = (s - vent) / (length - vent);
    // Blunt enough to read as a tail, not a needle; the tip itself closes.
    const taper = (1 - tail) ** 1.35 * (1 - 0.9 * tail ** 6);
    w *= Math.max(taper, 0);
    h *= Math.max(taper, 0);
  }
  target.w = w;
  target.h = h;
  return target;
}

/**
 * Unit cross-section outline at angle `theta` (0 on the spine, PI on the
 * belly, positive toward the right side). The back is a soft superellipse; the
 * belly is flatter and squarer so the body sits on it.
 */
export function sectionOutline(theta, target = { x: 0, y: 0 }) {
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  const upper = cos >= 0;
  const exponent = upper ? 2 / 2.3 : 2 / 3.2;
  target.x = Math.sign(sin) * Math.abs(sin) ** exponent * (upper ? 1 : 1.03);
  target.y = Math.sign(cos) * Math.abs(cos) ** exponent * (upper ? 1 : 0.62);
  return target;
}

/** Distance from the spine centre down to the belly at `s`. */
export function serpentBellyDepth(s, shape) {
  return serpentSection(s, shape).h * 0.62;
}

// Approximate perimeter (Ramanujan) of the section, with the flat belly.
function sectionPerimeter(w, h) {
  const b = h * 0.81;
  return Math.PI * (3 * (w + b) - Math.sqrt((3 * w + b) * (w + 3 * b)));
}

/**
 * Stations (ring positions) along the body: tight over the head, where the
 * shape changes fastest, looser along the body, tighter again at the tail tip.
 */
export function serpentStations(shape, { head = 0.028, body = 0.1, tail = 0.05 } = {}) {
  // Spacings are for a 0.5 m body; a bigger snake keeps the same ring count.
  const unit = shape.radius / 0.5;
  head *= unit;
  body *= unit;
  tail *= unit;
  const stations = [0];
  let s = 0;
  while (s < shape.length) {
    const toHead = smoothstep(shape.headLength, shape.neck + 1.2, s);
    const toTail = smoothstep(shape.length - 3 * shape.radius, shape.length - 0.4 * shape.radius, s);
    const step = lerp(lerp(head, body, toHead), tail, toTail);
    s = Math.min(shape.length, s + step);
    stations.push(s);
  }
  return Float32Array.from(stations);
}

/**
 * Scale-row coordinate along the body: one unit per scale row, with a row as
 * long as a scale is wide (perimeter / scaleRows), so scales stay square as
 * the girth changes. Integrated over `stations`.
 */
export function serpentScaleCoordinates(stations, shape) {
  const coordinates = new Float32Array(stations.length);
  const section = { w: 0, h: 0 };
  const minSize = shape.radius * 0.012;
  let v = 0;
  for (let index = 1; index < stations.length; index += 1) {
    const mid = (stations[index] + stations[index - 1]) * 0.5;
    serpentSection(mid, shape, section);
    const scaleSize = Math.max(minSize, sectionPerimeter(section.w, section.h) / shape.scaleRows);
    v += (stations[index] - stations[index - 1]) / scaleSize;
    coordinates[index] = v;
  }
  return coordinates;
}

/** Linear lookup of a per-station table at `s`. */
export function sampleStations(stations, values, s) {
  if (s <= stations[0]) return values[0];
  const last = stations.length - 1;
  if (s >= stations[last]) return values[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (stations[mid] <= s) lo = mid;
    else hi = mid;
  }
  const t = (s - stations[lo]) / Math.max(1e-6, stations[hi] - stations[lo]);
  return lerp(values[lo], values[hi], t);
}
