import { Box3, Vector3 } from 'three';

const CELL_SIZE = 64;

// Conservative rejection against the static terrain heightfield. A cell includes
// the emitter's whole radius and normal-sampling margin, including across cell edges.
export class SnowRegionBounds {
  constructor(terrain, config, radius = 0) {
    this.terrain = terrain;
    this.snow = config.ground?.snow;
    this.radius = radius;
    this.cells = new Map();
    this.box = new Box3(new Vector3(), new Vector3());
  }

  contains(x, z) {
    if (!this.snow?.enabled) return false;
    if (!this.terrain.getHeightRange) return true;
    const cx = Math.floor(x / CELL_SIZE), cz = Math.floor(z / CELL_SIZE);
    const key = `${cx},${cz}`;
    if (this.cells.has(key)) return this.cells.get(key);
    this.box.min.set(cx * CELL_SIZE - this.radius, -Infinity, cz * CELL_SIZE - this.radius);
    this.box.max.set((cx + 1) * CELL_SIZE + this.radius, Infinity, (cz + 1) * CELL_SIZE + this.radius);
    const { max } = this.terrain.getHeightRange(this.box);
    const highestDrift = Math.max(0, this.snow.wind.driftHeight) - Math.min(0, this.snow.wind.scourStrength);
    const possible = !Number.isFinite(max) || max + highestDrift > this.snow.altitude.start;
    // Bound the cache even when a free-fly camera travels beyond the world.
    if (this.cells.size >= 2048) this.cells.clear();
    this.cells.set(key, possible);
    return possible;
  }
}
