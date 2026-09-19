import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;
const ease = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);
const DEFAULT_BANK_BLEND = 7;
const DEFAULT_OUTLET_BANK_BLEND = 24;
const DEFAULT_OUTLET_DEPTH = 1.35;
const DEFAULT_MOUTH_DEPTH = 2.4;
// Water runs at FLAT_SPEED (m/s) on the level and approaches FALL_SPEED down
// a sheer drop, changing over SPEED_RESPONSE metres of surface.
const FLAT_SPEED = 1.4;
const FALL_SPEED = 6.5;
const SPEED_RESPONSE = 4;

export function measureRiverSurface(samples) {
  let surfaceDistance = 0, impact = 0, previousSlope = 0, flowSpeed = FLAT_SPEED, travelTime = 0;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i], before = samples[Math.max(0, i - 1)], after = samples[Math.min(samples.length - 1, i + 1)];
    const ds = p.s - before.s;
    const step = Math.hypot(ds, p.y - before.y);
    surfaceDistance += step;
    const slope = Math.max(0, (before.y - after.y) / Math.max(0.001, after.s - before.s));
    impact = Math.min(1, Math.max(impact * Math.exp(-ds / 9), (previousSlope - slope) * 2));
    // Seconds for the water to get here. Waterfall streaks ride on it, so
    // they stretch as the water accelerates and bunch up where it slows.
    const target = FLAT_SPEED + (FALL_SPEED - FLAT_SPEED) * ease(0.08, 0.9, slope);
    const nextSpeed = target + (flowSpeed - target) * Math.exp(-step / SPEED_RESPONSE);
    travelTime += step / ((flowSpeed + nextSpeed) / 2);
    flowSpeed = nextSpeed;
    Object.assign(p, { surfaceDistance, slope, impact, flowSpeed, travelTime });
    previousSlope = slope;
  }
}

// A fall starts where the course steepens past FALL_ENTER_SLOPE and ends at
// its foot, the first sample back under FALL_EXIT_SLOPE. Runs that drop less
// than FALL_MIN_DROP metres, or never pass FALL_MIN_PEAK, are rapids.
const FALL_ENTER_SLOPE = 0.35;
const FALL_EXIT_SLOPE = 0.2;
const FALL_MIN_DROP = 3;
const FALL_MIN_PEAK = 0.6;

/** Waterfalls along measured samples: `lip` and `foot` sample indices, `drop` in metres. */
export function findRiverFalls(samples) {
  const falls = [];
  let lip = -1, peak = 0;
  for (let i = 0; i <= samples.length; i++) {
    const slope = i < samples.length ? samples[i].slope ?? 0 : 0;
    if (lip < 0) {
      if (slope > FALL_ENTER_SLOPE) { lip = i; peak = slope; }
      continue;
    }
    peak = Math.max(peak, slope);
    if (slope >= FALL_EXIT_SLOPE) continue;
    const foot = Math.min(i, samples.length - 1);
    const drop = samples[Math.max(0, lip - 1)].y - samples[foot].y;
    if (drop >= FALL_MIN_DROP && peak >= FALL_MIN_PEAK) falls.push({ lip, foot, drop, peak });
    lip = -1;
  }
  return falls;
}

function resolveOutlet(settings, pointCount, lakeLevel) {
  if (settings.outletStartIndex === undefined) return null;
  const startIndex = Number(settings.outletStartIndex);
  const level = Number(settings.outletLevel);
  if (!Number.isInteger(startIndex) || startIndex <= 0 || startIndex >= pointCount - 1) {
    throw new Error('water.river.outletStartIndex must reference an interior control point.');
  }
  if (!Number.isFinite(level) || level >= lakeLevel) {
    throw new Error('water.river.outletLevel must be finite and below the lake level.');
  }
  return {
    startFraction: startIndex / (pointCount - 1),
    level,
    bankBlend: Number(settings.outletBankBlend ?? DEFAULT_OUTLET_BANK_BLEND),
    depth: Number(settings.outletDepth ?? DEFAULT_OUTLET_DEPTH),
    mouthDepth: Number(settings.mouthDepth ?? DEFAULT_MOUTH_DEPTH),
  };
}

/** One world-space course supplies terrain carving, ecology, shading and footsteps. */
export class RiverCourse {
  constructor(settings, sampleHeight, lakeLevel) {
    this.settings = settings;
    this.lakeLevel = lakeLevel;
    const points = settings.points.map(([x, z, width]) => ({ x, z, width }));
    const outlet = resolveOutlet(settings, points.length, lakeLevel);
    this.outletLevel = outlet?.level ?? lakeLevel;
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p.x, 0, p.z)), false, 'centripetal');
    const count = Math.ceil(curve.getLength() / 1.5);
    this.samples = [];
    this.cells = new Map();
    this.bounds = new THREE.Box3();
    let distance = 0;
    let previousY = Infinity;
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const p = curve.getPoint(t);
      const tangent = curve.getTangent(t).normalize();
      const q = Math.min(points.length - 2, Math.floor(t * (points.length - 1)));
      const f = t * (points.length - 1) - q;
      const width = THREE.MathUtils.lerp(points[q].width, points[q + 1].width, f)
        * (1 + Math.sin(t * count * 0.12) * 0.065 + Math.sin(t * count * 0.037) * 0.08);
      const rawY = sampleHeight(p.x, p.z) - 1.15;
      const outletProgress = outlet && t >= outlet.startFraction
        ? clamp((t - outlet.startFraction) / Math.max(0.0001, 1 - outlet.startFraction), 0, 1)
        : 0;
      const outletTarget = outlet
        ? THREE.MathUtils.lerp(lakeLevel, outlet.level, ease(0, 1, outletProgress))
        : lakeLevel;
      const y = outletProgress > 0
        ? Math.max(outlet.level, Math.min(previousY, outletTarget))
        : Math.max(lakeLevel, Math.min(previousY, rawY));
      if (i) distance += Math.hypot(p.x - this.samples[i - 1].x, p.z - this.samples[i - 1].z);
      const bankBlend = THREE.MathUtils.lerp(
        DEFAULT_BANK_BLEND,
        outlet?.bankBlend ?? DEFAULT_BANK_BLEND,
        outletProgress,
      );
      const sample = {
        x: p.x,
        z: p.z,
        y,
        width,
        s: distance,
        dx: tangent.x,
        dz: tangent.z,
        outletProgress,
        bankBlend,
      };
      this.samples.push(sample);
      previousY = y;
      this.bounds.expandByPoint(new THREE.Vector3(p.x, y, p.z));
    }
    this.length = distance;
    measureRiverSurface(this.samples);
    this.falls = findRiverFalls(this.samples);
    this.bounds.expandByScalar(35);
    this.size = this.bounds.getSize(new THREE.Vector3());
    for (let i = 0; i < count; i++) {
      const a = this.samples[i], b = this.samples[i + 1];
      const radius = Math.max(a.width, b.width) / 2 + Math.max(24, a.bankBlend, b.bankBlend);
      for (let z = Math.floor((Math.min(a.z, b.z) - radius) / 24); z <= Math.floor((Math.max(a.z, b.z) + radius) / 24); z++) {
        for (let x = Math.floor((Math.min(a.x, b.x) - radius) / 24); x <= Math.floor((Math.max(a.x, b.x) + radius) / 24); x++) {
          const key = `${x},${z}`;
          if (!this.cells.has(key)) this.cells.set(key, []);
          this.cells.get(key).push(i);
        }
      }
    }
  }

  sample(x, z) {
    const candidates = this.cells.get(`${Math.floor(x / 24)},${Math.floor(z / 24)}`);
    if (!candidates) return null;
    let best = Infinity, result = null;
    for (const index of candidates) {
      const a = this.samples[index], b = this.samples[index + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / Math.max(dx * dx + dz * dz, 0.0001), 0, 1);
      const px = x - a.x - dx * t, pz = z - a.z - dz * t;
      const distance = Math.hypot(px, pz);
      if (distance >= best) continue;
      best = distance;
      const width = THREE.MathUtils.lerp(a.width, b.width, t);
      const span = Math.max(b.s - a.s, 0.001);
      const lateral = (px * -dz + pz * dx) / span;
      const s = a.s + span * t;
      const erosion = Math.sin(s * 0.39 + Math.sign(lateral) * 1.8) * 0.38
        + Math.sin(s * 0.13 + Math.sign(lateral) * 3.1) * 0.55;
      result = {
        y: THREE.MathUtils.lerp(a.y, b.y, t),
        distance,
        edge: distance - width / 2 - erosion,
        width,
        s,
        dx: dx / span,
        dz: dz / span,
        slope: Math.max(0, (a.y - b.y) / span),
        lateral,
        outletProgress: THREE.MathUtils.lerp(a.outletProgress, b.outletProgress, t),
        bankBlend: THREE.MathUtils.lerp(a.bankBlend, b.bankBlend, t),
      };
    }
    return result;
  }

  carve(x, z, original) {
    const p = this.sample(x, z);
    if (!p || p.edge > p.bankBlend) return original;
    const crossing = 1 - ease(0, 7, Math.hypot(x - 88, z + 19));
    const upstreamDepth = THREE.MathUtils.lerp(1.25, 0.26, crossing);
    const outletDepth = THREE.MathUtils.lerp(
      Number(this.settings.outletDepth ?? DEFAULT_OUTLET_DEPTH),
      Number(this.settings.mouthDepth ?? DEFAULT_MOUTH_DEPTH),
      p.outletProgress,
    );
    const depth = THREE.MathUtils.lerp(upstreamDepth, outletDepth, p.outletProgress);
    const cross = clamp(1 + p.edge / (p.width * 0.5), 0, 1);
    const bed = p.y - depth + Math.pow(cross, 3) * depth * 0.72;
    const blend = 1 - ease(-0.1, p.bankBlend, p.edge);
    return Math.min(original, THREE.MathUtils.lerp(original, bed, blend));
  }

  createTexture() {
    const width = 384;
    const height = Math.ceil(width * this.size.z / this.size.x);
    const data = new Float32Array(width * height * 4);
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const x = this.bounds.min.x + (i + 0.5) / width * this.size.x;
      const z = this.bounds.min.z + (j + 0.5) / height * this.size.z;
      const p = this.sample(x, z);
      const k = (j * width + i) * 4;
      data[k] = p?.y ?? this.lakeLevel;
      data[k + 1] = p?.edge ?? 100;
      data[k + 2] = p?.s ?? 0;
      data[k + 3] = p ? Math.atan2(p.dz, p.dx) : 0;
    }
    // Half floats retain sub-centimetre bank distances and work on both backends.
    const half = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
    this.texture = new THREE.DataTexture(half, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
    return this.texture;
  }

  dispose() { this.texture?.dispose(); }
}
