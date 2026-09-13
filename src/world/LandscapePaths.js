import * as THREE from 'three';

const CELL_SIZE = 24;
const PATH_SAMPLE_SPACING = 4;
const MIN_SEGMENT_LENGTH = 0.001;

export const LANDSCAPE_ROUTES = [
  { name: 'River walk', width: 4.4, points: [[2, -5], [35, -12], [62, -28], [88, -19], [110, 8], [130, 52], [145, 104]] },
  { name: 'Forest loop', width: 3.8, points: [[2, -5], [-80, 20], [-155, 82], [-250, 130], [-350, 90], [-395, -20], [-310, -130], [-185, -110], [-60, -40], [2, -5]] },
  { name: 'Summit trail', width: 3.2, points: [[2, -5], [4, -85], [-30, -180], [-80, -250], [-125, -350], [-60, -440], [-150, -490], [-160, -580], [-70, -640], [-15, -710]] },
  { name: 'Stone country', width: 3.8, points: [[88, -19], [170, -75], [280, -120], [405, -170], [420, -280], [330, -320], [215, -245], [170, -160], [170, -75]] },
  { name: 'Lakeside circuit', width: 4, points: [[145, 104], [94, 196], [155, 340], [300, 414], [480, 378], [589, 255], [597, 102], [510, -30], [342, -74], [210, -25], [145, 104]] },
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
    return THREE.MathUtils.lerp(naturalHeight, targetHeight, bestBlend);
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
