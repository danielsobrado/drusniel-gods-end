import * as THREE from 'three';

export const LANDSCAPE_ROUTES = [
  { name: 'River walk', width: 4.4, points: [[2, -5], [35, -12], [62, -28], [88, -19], [110, 8], [130, 52], [145, 104]] },
  { name: 'Forest loop', width: 3.8, points: [[2, -5], [-80, 20], [-155, 82], [-250, 130], [-350, 90], [-395, -20], [-310, -130], [-185, -110], [-60, -40], [2, -5]] },
  { name: 'Summit trail', width: 3.2, points: [[2, -5], [4, -85], [-30, -180], [-80, -250], [-125, -350], [-60, -440], [-150, -490], [-160, -580], [-70, -640], [-15, -710]] },
  { name: 'Stone country', width: 3.8, points: [[88, -19], [170, -75], [280, -120], [405, -170], [420, -280], [330, -320], [215, -245], [170, -160], [170, -75]] },
  { name: 'Lakeside circuit', width: 4, points: [[145, 104], [94, 196], [155, 340], [300, 414], [480, 378], [589, 255], [597, 102], [510, -30], [342, -74], [210, -25], [145, 104]] },
];

export function forestWeight(x, z) {
  return Math.exp(-(((x + 280) / 210) ** 2) - ((z - 20) / 205) ** 2);
}

export class LandscapePaths {
  constructor(width, depth = width, centerX = 0, centerZ = 0, coast = false) {
    this.width = width; this.depth = depth;
    this.minX = centerX - width / 2; this.minZ = centerZ - depth / 2;
    this.cells = new Map();
    this.routes = [...LANDSCAPE_ROUTES];
    if (coast) this.routes.push(
      { name: 'Coastal approach', width: 4.5, points: [[589, 255], [650, 260], [733, 226], [810, 158], [877, 110], [930, 82]] },
      { name: 'Dune trail', width: 3.8, points: [[865, -240], [896, -150], [910, -70], [930, 82], [962, 203], [970, 320], [900, 440]] },
    );
    for (const route of this.routes) {
      const curve = new THREE.CatmullRomCurve3(route.points.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
      const samples = curve.getSpacedPoints(Math.ceil(curve.getLength() / 4));
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1], b = samples[i];
        const segment = { a, b, half: route.width / 2 };
        for (let z = Math.floor((Math.min(a.z, b.z) - 6) / 24); z <= Math.floor((Math.max(a.z, b.z) + 6) / 24); z++) {
          for (let x = Math.floor((Math.min(a.x, b.x) - 6) / 24); x <= Math.floor((Math.max(a.x, b.x) + 6) / 24); x++) {
            const key = `${x},${z}`;
            if (!this.cells.has(key)) this.cells.set(key, []);
            this.cells.get(key).push(segment);
          }
        }
      }
    }
  }

  sample(x, z) {
    let mask = 0;
    for (const { a, b, half } of this.cells.get(`${Math.floor(x / 24)},${Math.floor(z / 24)}`) ?? []) {
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / Math.max(0.001, dx * dx + dz * dz), 0, 1);
      const distance = Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
      const edgeNoise = Math.sin(x * 0.65 + Math.sin(z * 0.8)) * 0.25;
      mask = Math.max(mask, 1 - THREE.MathUtils.smoothstep(distance + edgeNoise, half - 0.5, half + 0.9));
    }
    return mask;
  }

  createTexture(resolution = 1024) {
    const data = new Uint8Array(resolution * resolution * 4);
    for (let z = 0; z < resolution; z++) for (let x = 0; x < resolution; x++) {
      const value = Math.round(this.sample((x + 0.5) / resolution * this.width + this.minX,
        (z + 0.5) / resolution * this.depth + this.minZ) * 255);
      const i = (z * resolution + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
    }
    this.texture = new THREE.DataTexture(data, resolution, resolution);
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    return this.texture;
  }

  dispose() { this.texture?.dispose(); }
}
