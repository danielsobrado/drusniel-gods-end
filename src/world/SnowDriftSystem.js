import { BufferGeometry, Float32BufferAttribute, Mesh } from 'three';
import { sampleSnowSurfaceCpu } from './SnowDeformationField.js';
import { hash2d } from '../grass/vegetationEcology.js';

const SEGMENTS = 8;
const CHUNK_SIZE = 40;
const MIN_COVERAGE = 0.7;
const PATH_CLEARANCE = 1.2;
const MAX_SLOPE = 0.45;
const LEE_STRETCH = 1.55;
const BURIED_EDGE = 0.055;

// Small, terrain-conforming deposits at roots and rocks. Their edges disappear
// below the terrain, and the elongated lee side follows the snowfall wind.
// The terrain material is borrowed, so snow color, grain and tracks match it.
export function createSnowDriftPatch(source, terrain, config) {
  const snow = config.ground?.snow;
  const settings = snow?.drifts;
  const { x, y, z } = source.position ?? {};
  if (!snow?.enabled || !settings?.enabled || ![x, y, z, source.radius].every(Number.isFinite)
    || source.radius <= 0 || y < snow.altitude.start - snow.wind.driftHeight) return null;
  const surface = sampleSnowSurfaceCpu(terrain, x, z, 1, config);
  if (!surface || surface.coverage < MIN_COVERAGE) return null;
  const slopeX = (terrain.sampleHeight(x + 1, z) - terrain.sampleHeight(x - 1, z)) / 2;
  const slopeZ = (terrain.sampleHeight(x, z + 1) - terrain.sampleHeight(x, z - 1)) / 2;
  if (Math.hypot(slopeX, slopeZ) > MAX_SLOPE) return null;

  const variation = hash2d(Math.floor(x * 8), Math.floor(z * 8), 4721);
  const radius = Math.min(settings.maxRadius, Math.max(1.4, source.radius * settings.radiusScale));
  const height = Math.min(settings.maxHeight, radius * settings.heightScale * (0.8 + variation * 0.4))
    * surface.coverage;
  const angle = snow.wind.angleDegrees * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  const positions = [], indices = [];
  const center = { x: x + c * radius * 0.28, z: z + s * radius * 0.28 };
  for (let row = 0; row <= SEGMENTS; row++) for (let col = 0; col <= SEGMENTS; col++) {
    const u = col / SEGMENTS * 2 - 1, v = row / SEGMENTS * 2 - 1;
    const along = u * radius * LEE_STRETCH, across = v * radius;
    const px = center.x + along * c - across * s;
    const pz = center.z + along * s + across * c;
    if (!terrain.contains(px, pz, PATH_CLEARANCE)) return null;
    const ground = terrain.sampleHeight(px, pz);
    if (!Number.isFinite(ground)) return null;
    const crown = Math.max(0, 1 - u * u - v * v) ** 2;
    if (crown > 0) {
      // Test the whole raised footprint, including a buffer around paths.
      if ([[0, 0], [PATH_CLEARANCE, 0], [-PATH_CLEARANCE, 0], [0, PATH_CLEARANCE], [0, -PATH_CLEARANCE]]
        .some(([dx, dz]) => (terrain.paths?.sample(px + dx, pz + dz) ?? 0) > 0.01)) return null;
      if ((sampleSnowSurfaceCpu(terrain, px, pz, 1, config)?.coverage ?? 0) < MIN_COVERAGE) return null;
    }
    positions.push(px, ground + crown * height - BURIED_EDGE, pz);
  }
  for (let row = 0; row < SEGMENTS; row++) for (let col = 0; col < SEGMENTS; col++) {
    const a = row * (SEGMENTS + 1) + col, b = a + SEGMENTS + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return { positions, indices, center, radius, height };
}

export class SnowDriftSystem {
  constructor({ scene, terrain, material, config, trees = [], props = [] }) {
    this.scene = scene;
    this.meshes = [];
    this.count = 0;
    if (!config.ground?.snow?.enabled || !config.ground.snow.drifts?.enabled || !material) return;
    const sources = [...props, ...trees.flatMap(tree => {
      const collider = config.trees?.types?.[tree.typeIndex]?.collider;
      return collider ? [{ position: tree.position,
        radius: Math.max(collider.width, collider.length) * tree.scale * 0.5 }] : [];
    })];
    const occupied = [];
    const chunks = new Map();
    for (const source of sources) {
      if (this.count >= config.ground.snow.drifts.maxCount) break;
      if (!source.position || occupied.some(p => Math.hypot(p.x - source.position.x, p.z - source.position.z)
        < p.radius * 2)) continue;
      const patch = createSnowDriftPatch(source, terrain, config);
      if (!patch) continue;
      occupied.push({ ...patch.center, radius: patch.radius });
      const key = `${Math.floor(patch.center.x / CHUNK_SIZE)},${Math.floor(patch.center.z / CHUNK_SIZE)}`;
      if (!chunks.has(key)) chunks.set(key, { positions: [], indices: [] });
      const chunk = chunks.get(key), offset = chunk.positions.length / 3;
      chunk.positions.push(...patch.positions);
      chunk.indices.push(...patch.indices.map(index => index + offset));
      this.count++;
    }
    for (const [key, chunk] of chunks) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(chunk.positions, 3));
      const uv = [];
      for (let i = 0; i < chunk.positions.length; i += 3) {
        uv.push((chunk.positions[i] - (terrain.bounds?.min.x ?? 0)) / (terrain.size?.x ?? 1),
          (chunk.positions[i + 2] - (terrain.bounds?.min.z ?? 0)) / (terrain.size?.z ?? 1));
      }
      geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
      geometry.setIndex(chunk.indices);
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const mesh = new Mesh(geometry, material);
      mesh.name = `Snow drifts ${key}`;
      mesh.receiveShadow = true;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  dispose() {
    for (const mesh of this.meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.length = 0;
    this.count = 0;
  }
}
