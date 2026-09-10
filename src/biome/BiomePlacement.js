import { createSeededRandom } from '../core/math.js';

export const DEFAULT_BIOME_TEMPLATES = Object.freeze({
  cactus: Object.freeze({ radius: 0.55 }),
  shrubSmall: Object.freeze({ radius: 0.4 }),
  shrubLarge: Object.freeze({ radius: 0.65 }),
  rockA: Object.freeze({ radius: 0.85 }),
  rockB: Object.freeze({ radius: 0.95 }),
});

const SOLID_KINDS = new Set(['cactus', 'rockA', 'rockB']);

/** Conservative circular occupied footprints; bucketed for bounded local queries. */
export class BiomeFootprints {
  constructor(cellSize = 16) { this.cellSize = cellSize; this.cells = new Map(); }
  add(record) {
    const r = record.radius + 3, s = this.cellSize;
    for (let x = Math.floor((record.x - r) / s); x <= Math.floor((record.x + r) / s); x++) {
      for (let z = Math.floor((record.z - r) / s); z <= Math.floor((record.z + r) / s); z++) {
        const key = `${x},${z}`;
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(record);
      }
    }
  }
  nearby(x, z, radius = 0) {
    const found = new Set(), s = this.cellSize;
    for (let cx = Math.floor((x - radius) / s); cx <= Math.floor((x + radius) / s); cx++) {
      for (let cz = Math.floor((z - radius) / s); cz <= Math.floor((z + radius) / s); cz++) {
        for (const record of this.cells.get(`${cx},${cz}`) ?? []) found.add(record);
      }
    }
    return found;
  }
  overlaps(x, z, radius = 0) {
    for (const r of this.nearby(x, z, radius)) {
      if ((x - r.x) ** 2 + (z - r.z) ** 2 < (r.radius + radius) ** 2) return true;
    }
    return false;
  }
  exposure(x, z) {
    let exposure = 0;
    for (const r of this.nearby(x, z)) {
      exposure = Math.max(exposure, Math.min(1, Math.max(0, (r.radius + 2 - Math.hypot(x - r.x, z - r.z)) / 2)));
    }
    return exposure;
  }
}

export function occupiedFromWorld({ trees = [], props = [], config } = {}) {
  const occupied = new BiomeFootprints();
  for (const tree of trees) {
    const collider = config?.trees?.types?.[tree.typeIndex]?.collider;
    const radius = Math.max(collider?.width ?? 1.2, collider?.length ?? 1.2) * (tree.scale ?? 1) * 0.5;
    occupied.add({
      x: tree.position.x, z: tree.position.z, radius, id: `tree:${tree.index ?? tree.typeIndex}`,
    });
  }
  for (const instance of props) {
    const position = instance.position ?? instance;
    const radius = instance.radius
      ?? instance.geometry?.boundingSphere?.radius
      ?? 1;
    occupied.add({ x: position.x, z: position.z, radius, id: instance.name ?? 'prop' });
  }
  return occupied;
}

export function validBiomeGround(terrain, ecology, x, z, radius = 0, waterY = Number.NEGATIVE_INFINITY) {
  // Concentric samples include the footprint interior, plus a one-metre path margin.
  for (let ring = 0; ring <= Math.ceil((radius + 1) * 2); ring++) {
    const r = Math.min(radius + 1, ring * 0.5);
    const samples = Math.max(1, Math.ceil(2 * Math.PI * r / 0.5));
    for (let i = 0; i < samples; i++) {
      const px = x + Math.cos(i / samples * Math.PI * 2) * r;
      const pz = z + Math.sin(i / samples * Math.PI * 2) * r;
      if (!terrain.contains(px, pz)) return false;
      const e = ecology.sampleWorld(px, pz), y = terrain.sampleHeight(px, pz);
      if (!Number.isFinite(y) || y < waterY + 0.15 || e.path >= 0.3 || e.density <= 0.08 || y >= 95) return false;
      if (Math.hypot(terrain.sampleHeight(px + 1, pz) - y,
        terrain.sampleHeight(px, pz + 1) - y) > 0.55) return false;
    }
  }
  return true;
}

export function* generateBiomeRecords({
  profile, terrain, ecology, field, templates, occupied, solids, waterY = Number.NEGATIVE_INFINITY,
} = {}) {
  const size = profile.cellSize ?? 32, b = terrain.bounds;
  const catalog = { ...DEFAULT_BIOME_TEMPLATES, ...templates };
  for (let cx = Math.floor(b.min.x / size); cx <= Math.floor(b.max.x / size); cx++) {
    for (let cz = Math.floor(b.min.z / size); cz <= Math.floor(b.max.z / size); cz++) {
      const random = createSeededRandom(Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ profile.seed);
      const x = (cx + random()) * size, z = (cz + random()) * size;
      if (random() >= (profile.clusterChance ?? 0.55)) { yield; continue; }
      if (!validBiomeGround(terrain, ecology, x, z, 0, waterY)) { yield; continue; }
      const e = ecology.sampleWorld(x, z), f = field.sampleWorld(x, z);
      const kinds = f.dryness >= 0.6 && e.understory < 0.35 ? ['cactus', 'cactus', 'shrubSmall']
        : e.understory >= 0.35 ? ['shrubSmall', 'shrubLarge', 'shrubSmall'] : ['shrubSmall', 'shrubLarge'];
      if (e.understory < 0.35 && kinds[0] !== 'cactus' && random() < 0.25) {
        kinds.push(random() < 0.5 ? 'rockA' : 'rockB');
      }
      for (let i = 0; i < kinds.length; i++) {
        const kind = kinds[i], angle = random() * Math.PI * 2, distance = Math.sqrt(random()) * 4;
        const px = x + Math.cos(angle) * distance, pz = z + Math.sin(angle) * distance;
        const scale = kind === 'cactus' ? [0.9, 1.4, 1.9][Math.floor(random() * 3)] : 0.9 + random() * 0.6;
        const radius = (catalog[kind]?.radius ?? 0.5) * scale;
        const record = { id: `${cx}:${cz}:${i}`, kind, x: px, z: pz,
          y: terrain.sampleHeight(px, pz), scale, radius, yaw: random() * Math.PI * 2,
          decorative: !SOLID_KINDS.has(kind), selection: random() };
        if (validBiomeGround(terrain, ecology, px, pz, radius, waterY) && !occupied.overlaps(px, pz, radius)) {
          if (!record.decorative) { occupied.add(record); solids.add(record); }
          yield record;
        }
        yield;
      }
    }
  }
}

export function selectDecorativeRecords(records, shrubDensity = 1) {
  return records.filter((record) => !record.decorative || record.selection < shrubDensity);
}

export function findSafeBiomePosition({
  position, terrain, ecology, occupied, radius, rootToFeet, groundOffset = 0, waterY = Number.NEGATIVE_INFINITY,
}) {
  const test = (x, z) => !occupied.overlaps(x, z, radius)
    && validBiomeGround(terrain, ecology, x, z, radius, waterY)
    ? { x, z, y: terrain.sampleHeight(x, z) + rootToFeet + groundOffset } : null;
  const current = test(position.x, position.z);
  if (current) return current;
  for (let r = 1; r <= 12; r++) for (let i = 0; i < 16; i++) {
    const result = test(position.x + Math.cos(i * Math.PI / 8) * r, position.z + Math.sin(i * Math.PI / 8) * r);
    if (result) return result;
  }
  return null;
}
