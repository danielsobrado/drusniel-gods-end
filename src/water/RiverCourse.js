import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;
const ease = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);

export function measureRiverSurface(samples) {
  let surfaceDistance = 0, impact = 0, previousSlope = 0;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i], before = samples[Math.max(0, i - 1)], after = samples[Math.min(samples.length - 1, i + 1)];
    const ds = p.s - before.s;
    surfaceDistance += Math.hypot(ds, p.y - before.y);
    const slope = Math.max(0, (before.y - after.y) / Math.max(0.001, after.s - before.s));
    impact = Math.min(1, Math.max(impact * Math.exp(-ds / 9), (previousSlope - slope) * 2));
    Object.assign(p, { surfaceDistance, slope, impact });
    previousSlope = slope;
  }
}

/** One world-space course supplies terrain carving, ecology, shading and footsteps. */
export class RiverCourse {
  constructor(settings, sampleHeight, lakeLevel) {
    this.settings = settings;
    this.lakeLevel = lakeLevel;
    const points = settings.points.map(([x, z, width]) => ({ x, z, width }));
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
      // The last reach is level with the lake; upstream always runs downhill.
      const rawY = sampleHeight(p.x, p.z) - 1.15;
      const y = Math.max(lakeLevel, Math.min(previousY, rawY));
      if (i) distance += Math.hypot(p.x - this.samples[i - 1].x, p.z - this.samples[i - 1].z);
      const sample = { x: p.x, z: p.z, y, width, s: distance, dx: tangent.x, dz: tangent.z };
      this.samples.push(sample);
      previousY = y;
      this.bounds.expandByPoint(new THREE.Vector3(p.x, y, p.z));
    }
    this.length = distance;
    measureRiverSurface(this.samples);
    this.bounds.expandByScalar(35);
    this.size = this.bounds.getSize(new THREE.Vector3());
    for (let i = 0; i < count; i++) {
      const a = this.samples[i], b = this.samples[i + 1];
      const radius = Math.max(a.width, b.width) / 2 + 24;
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
      // Different erosion on each bank, shared by carving and the shader mask.
      const erosion = Math.sin(s * 0.39 + Math.sign(lateral) * 1.8) * 0.38
        + Math.sin(s * 0.13 + Math.sign(lateral) * 3.1) * 0.55;
      result = { y: THREE.MathUtils.lerp(a.y, b.y, t), distance, edge: distance - width / 2 - erosion,
        width, s: a.s + span * t, dx: dx / span, dz: dz / span,
        slope: Math.max(0, (a.y - b.y) / span), lateral };
    }
    return result;
  }

  carve(x, z, original) {
    const p = this.sample(x, z);
    if (!p || p.edge > 7) return original;
    const crossing = 1 - ease(0, 7, Math.hypot(x - 88, z + 19));
    const depth = THREE.MathUtils.lerp(1.25, 0.26, crossing);
    const cross = clamp(1 + p.edge / (p.width * 0.5), 0, 1);
    const bed = p.y - depth + Math.pow(cross, 3) * depth * 0.72;
    const blend = 1 - ease(-0.1, 7, p.edge);
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
