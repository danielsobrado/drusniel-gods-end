import * as THREE from 'three';
import { fractalNoise, smoothstep } from '../grass/vegetationEcology.js';

const CELL_SIZE = 24;
const PATH_SAMPLE_SPACING = 4;
const MIN_SEGMENT_LENGTH = 0.001;
// Cut walls: how far to march out from a segment looking for terrain above the
// wall, the march step, and the slack kept beyond the last terrain found.
const CUT_MAX_REACH = 260;
const CUT_REACH_STEP = 5;
const CUT_REACH_MARGIN = 12;
// World-space noise that varies cut walls; one field for every route, so walls
// of two routes that overlap agree.
const CUT_NOISE_SEED = 4127;
const CUT_RIM_ROUNDING = 8;

export const LANDSCAPE_ROUTES = [
  { name: 'River walk', width: 4.4, points: [[2, -5], [35, -12], [62, -28], [88, -19], [110, 8], [130, 52], [145, 104]] },
  { name: 'Forest loop', width: 3.8, points: [[2, -5], [-80, 20], [-155, 82], [-250, 130], [-350, 90], [-395, -20], [-310, -130], [-185, -110], [-60, -40], [2, -5]] },
  { name: 'Summit trail', width: 3.2, points: [[2, -5], [4, -85], [-30, -180], [-80, -250], [-125, -350], [-60, -440], [-150, -490], [-160, -580], [-70, -640], [-15, -710]] },
  { name: 'Stone country', width: 3.8, points: [[88, -19], [170, -75], [280, -120], [405, -170], [420, -280], [330, -320], [215, -245], [170, -160], [170, -75]] },
  { name: 'Lakeside circuit', width: 4, points: [[145, 104], [94, 196], [155, 340], [270, 430], [400, 500], [500, 522], [580, 482], [612, 380], [612, 262], [594, 70], [510, -30], [342, -74], [210, -25], [145, 104]] },
];

const COAST_ROUTES = [
  { name: 'Coastal approach', width: 4.5, points: [[589, 255], [650, 260], [733, 226], [810, 158], [877, 110], [930, 82]] },
  { name: 'Dune trail', width: 3.8, points: [[865, -240], [896, -150], [910, -70], [930, 82], [962, 203], [970, 320], [900, 440]] },
];

export function forestWeight(x, z) {
  return Math.exp(-(((x + 280) / 210) ** 2) - ((z - 20) / 205) ** 2);
}

function routeCurve(route) {
  return new THREE.CatmullRomCurve3(
    route.points.map(([x, z]) => new THREE.Vector3(Number(x), 0, Number(z))),
    false,
    'centripetal',
  );
}

function cellRange(a, b, padding) {
  return {
    minX: Math.floor((Math.min(a.x, b.x) - padding) / CELL_SIZE),
    maxX: Math.floor((Math.max(a.x, b.x) + padding) / CELL_SIZE),
    minZ: Math.floor((Math.min(a.z, b.z) - padding) / CELL_SIZE),
    maxZ: Math.floor((Math.max(a.z, b.z) + padding) / CELL_SIZE),
  };
}

function addSegment(cells, segment, padding) {
  const range = cellRange(segment.a, segment.b, padding);
  for (let z = range.minZ; z <= range.maxZ; z += 1) {
    for (let x = range.minX; x <= range.maxX; x += 1) {
      const key = `${x},${z}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(segment);
    }
  }
}

function clampGradeForward(samples, maxGrade) {
  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1], current = samples[i];
    const distance = Math.max(MIN_SEGMENT_LENGTH, Math.hypot(current.x - previous.x, current.z - previous.z));
    const limit = distance * maxGrade;
    current.y = THREE.MathUtils.clamp(current.y, previous.y - limit, previous.y + limit);
  }
}

function constrainGrade(samples, maxGrade) {
  clampGradeForward(samples, maxGrade);
  for (let i = samples.length - 2; i >= 0; i -= 1) {
    const current = samples[i], next = samples[i + 1];
    const distance = Math.max(MIN_SEGMENT_LENGTH, Math.hypot(current.x - next.x, current.z - next.z));
    const limit = distance * maxGrade;
    current.y = THREE.MathUtils.clamp(current.y, next.y - limit, next.y + limit);
  }
  clampGradeForward(samples, maxGrade);
}

function resolveCut(cut, route) {
  if (!cut) return null;
  const slope = Number(cut.slope);
  return {
    floorHalf: Number(cut.floorWidth ?? Number(route.width) + 2) * 0.5,
    slope,
    slopeVariation: Number(cut.slopeVariation ?? 0),
    fillSlope: Number(cut.fillSlope ?? slope),
    toe: Math.max(MIN_SEGMENT_LENGTH, Number(cut.toe ?? 0)),
    meander: Number(cut.meander ?? 0),
    benchHeight: Number(cut.benchHeight ?? 0),
    benchFraction: Number(cut.benchFraction ?? 0.5),
    roughness: Number(cut.roughness ?? 0),
  };
}

// Horizontal run past the floor with a quadratic toe, so the floor bends into
// the wall instead of creasing against it.
function toeRun(run, toe) {
  if (run <= 0) return 0;
  return run < toe ? run * run / (2 * toe) : run - toe / 2;
}

// `along` is distance along the route and `side` which wall, so gullies and
// spurs run straight down the fall line of each wall.
function cutNoise(x, z, along, side) {
  return {
    slope: fractalNoise(x * 0.011, z * 0.011, CUT_NOISE_SEED, 2) * 2 - 1,
    gully: fractalNoise(along * 0.05, side * 17.3, CUT_NOISE_SEED + 11, 3) * 2 - 1,
    bench: fractalNoise(x * 0.02, z * 0.02, CUT_NOISE_SEED + 23, 2) * 2 - 1,
    benchMask: smoothstep(0.38, 0.58, fractalNoise(x * 0.012, z * 0.012, CUT_NOISE_SEED + 29, 2)),
    phase: fractalNoise(x * 0.012, z * 0.012, CUT_NOISE_SEED + 37, 2) * 2,
    rough: fractalNoise(x * 0.09, z * 0.09, CUT_NOISE_SEED + 51, 3) * 2 - 1,
  };
}

// Height of a cut wall above the route floor at `run` metres past the floor
// edge. The mean rise is `slope`, varied along the route. Gullies and spurs
// push the wall back and forth along the fall line. Where the bench mask is
// set the wall is stepped into benches: ledges that hold snow between risers
// too steep for it. Bench height and phase drift with world position, so
// ledges tilt, pinch out between gullies and stop, rather than stacking as
// contour lines.
export function cutWallRise(run, cut, noise) {
  if (run <= 0) return 0;
  const slope = cut.slope * (1 + cut.slopeVariation * noise.slope);
  const meandered = Math.max(0, run + cut.meander * noise.gully * smoothstep(0, cut.toe + 4, run));
  const rise = slope * toeRun(meandered, cut.toe);
  let height = rise;
  if (cut.benchHeight > 0 && noise.benchMask > 0) {
    const step = cut.benchHeight * (1 + 0.3 * noise.bench);
    const phase = noise.phase * step;
    const staircase = (value) => {
      const level = value / step;
      const floor = Math.floor(level);
      return (floor + smoothstep(cut.benchFraction, 1, level - floor)) * step;
    };
    // Offset so the staircase starts at the floor: monotonic, and zero there.
    const terraced = staircase(rise + phase) - staircase(phase);
    height = rise + (terraced - rise) * noise.benchMask;
  }
  return Math.max(0, height + cut.roughness * noise.rough * smoothstep(0, 8, rise));
}

// Polynomial smooth minimum: min(a, b) with the crease rounded over `k`.
function smoothMin(a, b, k) {
  if (!(k > MIN_SEGMENT_LENGTH)) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function nearestPoint(segment, x, z) {
  const dx = segment.b.x - segment.a.x;
  const dz = segment.b.z - segment.a.z;
  const denominator = Math.max(MIN_SEGMENT_LENGTH, dx * dx + dz * dz);
  const t = THREE.MathUtils.clamp(((x - segment.a.x) * dx + (z - segment.a.z) * dz) / denominator, 0, 1);
  return {
    t,
    distance: Math.hypot(x - segment.a.x - t * dx, z - segment.a.z - t * dz),
  };
}

export class LandscapePaths {
  constructor(width, depth = width, centerX = 0, centerZ = 0, coast = false, routes = [], sampleHeight = null) {
    this.width = width;
    this.depth = depth;
    this.minX = centerX - width / 2;
    this.minZ = centerZ - depth / 2;
    this.cells = new Map();
    this.terrainCells = new Map();
    this.cutCells = new Map();
    this.routes = [...LANDSCAPE_ROUTES, ...(coast ? COAST_ROUTES : []), ...(Array.isArray(routes) ? routes : [])];

    for (const route of this.routes) {
      if (!Array.isArray(route.points) || route.points.length < 2 || !(Number(route.width) > 0)) continue;
      const curve = routeCurve(route);
      const samples = curve.getSpacedPoints(Math.max(1, Math.ceil(curve.getLength() / PATH_SAMPLE_SPACING)));
      for (let i = 1; i < samples.length; i += 1) {
        addSegment(this.cells, { a: samples[i - 1], b: samples[i], half: Number(route.width) / 2 }, 6);
      }
      if (!route.walkable || typeof sampleHeight !== 'function') continue;
      this.#indexWalkableRoute(route, samples, sampleHeight);
    }
  }

  #indexWalkableRoute(route, samples, sampleHeight) {
    const maxGrade = Number(route.maxGrade);
    const terrainWidth = Number(route.terrainWidth);
    if (!(maxGrade > 0) || !(terrainWidth > Number(route.width))) return;

    const terrainSamples = samples.map((point) => {
      const natural = sampleHeight(point.x, point.z);
      // Later routes inherit already-carved walkable height at junctions so a
      // spur cannot start 90 m above the road it forks from.
      return new THREE.Vector3(point.x, this.conformHeight(point.x, point.z, natural), point.z);
    });
    constrainGrade(terrainSamples, maxGrade);

    const cut = resolveCut(route.cut, route);
    if (cut) {
      let along = 0;
      for (let i = 1; i < terrainSamples.length; i += 1) {
        const segment = { a: terrainSamples[i - 1], b: terrainSamples[i], cut, along };
        segment.length = Math.hypot(segment.b.x - segment.a.x, segment.b.z - segment.a.z);
        along += segment.length;
        segment.reach = this.#cutReach(segment, sampleHeight);
        addSegment(this.cutCells, segment, segment.reach + 1);
      }
      return;
    }

    for (let i = 1; i < terrainSamples.length; i += 1) {
      const segment = {
        a: terrainSamples[i - 1],
        b: terrainSamples[i],
        flatHalf: Number(route.width) * 0.5 + 1,
        half: terrainWidth * 0.5,
      };
      addSegment(this.terrainCells, segment, segment.half + 1);
    }
  }

  // Lateral distance within which a cut segment still shapes the terrain: past
  // the last point on either side where the natural terrain stands above the
  // lowest the wall could be, or below the lowest fill.
  #cutReach(segment, sampleHeight) {
    const { a, b, cut } = segment;
    const length = Math.max(MIN_SEGMENT_LENGTH, Math.hypot(b.x - a.x, b.z - a.z));
    const nx = -(b.z - a.z) / length, nz = (b.x - a.x) / length;
    const mx = (a.x + b.x) * 0.5, my = (a.y + b.y) * 0.5, mz = (a.z + b.z) * 0.5;
    const lowestSlope = cut.slope * Math.max(0.1, 1 - cut.slopeVariation);
    const slack = cut.benchHeight * 1.3 + cut.roughness;
    let reach = cut.floorHalf + cut.toe + CUT_REACH_MARGIN;
    for (const side of [-1, 1]) {
      for (let distance = cut.floorHalf; distance <= CUT_MAX_REACH; distance += CUT_REACH_STEP) {
        const natural = sampleHeight(mx + nx * side * distance, mz + nz * side * distance);
        const run = toeRun(distance - cut.floorHalf - cut.meander, cut.toe);
        const above = natural > my + lowestSlope * run - slack;
        const below = natural < my - cut.fillSlope * toeRun(distance - cut.floorHalf, cut.toe);
        if (above || below) reach = Math.max(reach, distance + CUT_REACH_MARGIN);
      }
    }
    return Math.min(reach, CUT_MAX_REACH);
  }

  #cutHeight(x, z, height) {
    const segments = this.cutCells.get(`${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`);
    if (!segments) return height;
    // The nearest segment sets the route coordinates the wall noise follows.
    let closest = null, closestDistance = Infinity, closestT = 0;
    for (const segment of segments) {
      const { t, distance } = nearestPoint(segment, x, z);
      if (distance < segment.reach && distance < closestDistance) {
        closest = segment; closestDistance = distance; closestT = t;
      }
    }
    if (!closest) return height;
    const { a, b } = closest;
    const side = Math.sign((b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x)) || 1;
    const noise = cutNoise(x, z, closest.along + closestT * closest.length, side);

    let cap = Infinity, fill = -Infinity;
    let nearest = null, nearestDistance = Infinity;
    for (const segment of segments) {
      const { t, distance } = nearestPoint(segment, x, z);
      if (distance >= segment.reach) continue;
      const floor = THREE.MathUtils.lerp(segment.a.y, segment.b.y, t);
      const run = distance - segment.cut.floorHalf;
      const segmentCap = floor + cutWallRise(run, segment.cut, noise);
      const segmentFill = floor - segment.cut.fillSlope * toeRun(run, segment.cut.toe);
      cap = Math.min(cap, segmentCap);
      fill = Math.max(fill, segmentFill);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = { cap: segmentCap, fill: segmentFill, floor };
      }
    }
    if (!nearest) return height;
    // Two passes of a route at different heights can disagree; the nearer wins.
    if (fill > cap) ({ cap, fill } = nearest);
    // Round the rim where a wall meets the natural slope; a hard crease running
    // diagonally across the terrain grid shows as a row of sawteeth. The
    // rounding grows with the wall, so the floor itself stays exact.
    const rounding = (wall) => CUT_RIM_ROUNDING * smoothstep(0, CUT_RIM_ROUNDING * 2, wall);
    const cut = smoothMin(height, cap, rounding(cap - nearest.floor));
    return -smoothMin(-cut, -fill, rounding(nearest.floor - fill));
  }

  sample(x, z) {
    let mask = 0;
    for (const segment of this.cells.get(`${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`) ?? []) {
      const { distance } = nearestPoint(segment, x, z);
      const edgeNoise = Math.sin(x * 0.65 + Math.sin(z * 0.8)) * 0.25;
      mask = Math.max(mask, 1 - THREE.MathUtils.smoothstep(distance + edgeNoise, segment.half - 0.5, segment.half + 0.9));
    }
    return mask;
  }

  conformHeight(x, z, naturalHeight) {
    let bestScore = -Infinity;
    let bestBlend = 0;
    let targetHeight = naturalHeight;
    for (const segment of this.terrainCells.get(`${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`) ?? []) {
      const { t, distance } = nearestPoint(segment, x, z);
      if (distance >= segment.half) continue;
      const blend = 1 - THREE.MathUtils.smoothstep(distance, segment.flatHalf, segment.half);
      const score = blend * 1000 - distance;
      if (score <= bestScore) continue;
      bestScore = score;
      bestBlend = blend;
      targetHeight = THREE.MathUtils.lerp(segment.a.y, segment.b.y, t);
    }
    return this.#cutHeight(x, z, THREE.MathUtils.lerp(naturalHeight, targetHeight, bestBlend));
  }

  createTexture(resolution = 1024) {
    const data = new Uint8Array(resolution * resolution * 4);
    for (let z = 0; z < resolution; z += 1) for (let x = 0; x < resolution; x += 1) {
      const value = Math.round(this.sample(
        (x + 0.5) / resolution * this.width + this.minX,
        (z + 0.5) / resolution * this.depth + this.minZ,
      ) * 255);
      const i = (z * resolution + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
    this.texture = new THREE.DataTexture(data, resolution, resolution);
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    return this.texture;
  }

  dispose() { this.texture?.dispose(); }
}
