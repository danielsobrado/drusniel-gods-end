import * as THREE from 'three/webgpu';
import { attribute, vec3 } from 'three/tsl';
import { createSeededRandom } from '../core/math.js';
import { coastX, resolveCoastConfig, sampleCoastField } from './CoastField.js';
import { InstancedLodSet } from './InstancedLodSet.js';
import { DRAW_ORDER } from '../rendering/drawOrder.js';

// Starfish stranded on the damp lower beach, in loose patches. One low-poly
// five-armed star (a raised ridge down each arm) near, a flat ten-triangle
// star further out, and nothing past a starfish-sized distance.
const SEED = 40517;
const ATTEMPTS = 2600;
const NEAR = 22;
const FAR = 55;
// Shallow reds, oranges, a purple and a sandy one.
const COLORS = ['#d9622b', '#c2412f', '#e08a3c', '#7d3f8c', '#d7a15a'].map(hex => new THREE.Color(hex));

// Radius 1, lying on y = 0. `ridge` adds a raised spine down each arm.
function starGeometry(ridge) {
  const positions = [];
  const arms = 5;
  const centre = [0, 0.2, 0];
  const outline = [];
  for (let i = 0; i < arms * 2; i += 1) {
    const angle = (i / (arms * 2)) * Math.PI * 2;
    const radius = i % 2 === 0 ? 1 : 0.4;
    outline.push([Math.cos(angle) * radius, i % 2 === 0 ? 0.02 : 0.04, Math.sin(angle) * radius]);
  }
  const push = (...points) => { for (const p of points) positions.push(...p); };
  for (let i = 0; i < outline.length; i += 1) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    if (!ridge) { push(centre, b, a); continue; }
    // Tip index is even; the ridge point sits halfway out along the arm.
    const tip = i % 2 === 0 ? a : b;
    const valley = i % 2 === 0 ? b : a;
    const mid = [tip[0] * 0.55, 0.13, tip[2] * 0.55];
    if (i % 2 === 0) push(centre, mid, valley), push(mid, tip, valley);
    else push(centre, valley, mid), push(mid, valley, tip);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function surfaceNormal(terrain, x, z, target) {
  return target.set(
    terrain.sampleHeight(x - 0.2, z) - terrain.sampleHeight(x + 0.2, z),
    0.4,
    terrain.sampleHeight(x, z - 0.2) - terrain.sampleHeight(x, z + 0.2),
  ).normalize();
}

function place(terrain, sea, random) {
  const records = [];
  const normal = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const quaternion = new THREE.Quaternion();
  const spin = new THREE.Quaternion();
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const z = THREE.MathUtils.lerp(terrain.bounds.min.z + 4, terrain.bounds.max.z - 4, random());
    // The damp lower beach: just above where the waves reach, up to ~35 m inland.
    const inland = 3 + random() * 32;
    const x = coastX(z, sea) - inland;
    if (x < terrain.bounds.min.x + 2 || x > terrain.bounds.max.x - 2) continue;
    const field = sampleCoastField(x, z, 0, sea);
    if (field.waterCoverage > 0.001) continue;
    // Loose patches, densest where the sand stays wet.
    const patch = Math.sin(z * 0.043 + Math.sin(x * 0.07) * 2) * 0.5 + 0.5;
    if (random() > patch * patch * (0.25 + field.baseMoisture * 0.75)) continue;
    const y = terrain.sampleHeight(x, z);
    if (!Number.isFinite(y) || y <= sea.level + 0.08) continue;
    surfaceNormal(terrain, x, z, normal);
    if (normal.y < 0.9) continue;
    const size = 0.09 + random() * 0.12;
    quaternion.setFromUnitVectors(up, normal).multiply(spin.setFromAxisAngle(up, random() * Math.PI * 2));
    const position = new THREE.Vector3(x, y + 0.005, z);
    const matrix = new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(size, size * (0.8 + random() * 0.4), size));
    records.push({ position, matrix, color: COLORS[Math.floor(random() * COLORS.length)] });
  }
  return records;
}

export class BeachStarfish {
  constructor({ scene, terrain, config }) {
    this.set = null;
    if (!config.water?.sea?.enabled || !terrain?.bounds) return;
    const sea = resolveCoastConfig(config.water.sea);
    const records = place(terrain, sea, createSeededRandom(SEED));
    if (!records.length) return;
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, side: THREE.DoubleSide });
    material.colorNode = vec3(attribute('starTint', 'vec3'));
    this.set = new InstancedLodSet({
      scene, name: 'Beach starfish', records, material, renderOrder: DRAW_ORDER.props,
      levels: [{ geometry: starGeometry(true), maxDistance: NEAR }, { geometry: starGeometry(false), maxDistance: FAR }],
      attributes: { starTint: { itemSize: 3, read: (record, out) => { out[0] = record.color.r; out[1] = record.color.g; out[2] = record.color.b; } } },
    });
  }

  get count() {
    return this.set?.instanceCount ?? 0;
  }

  update(camera) {
    this.set?.update(camera);
  }

  dispose() {
    this.set?.meshes[0]?.material.dispose();
    this.set?.dispose();
    this.set = null;
  }
}
