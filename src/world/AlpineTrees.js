import { createSeededRandom } from '../core/math.js';
import { alpineDistance } from './AlpineRegion.js';

export function createAlpineTrees(alpine, terrain, paths) {
  if (!alpine) return [];
  const result = [], random = createSeededRandom(73019);
  for (let z = alpine.centerZ - alpine.outerRadius; z < alpine.centerZ + alpine.outerRadius; z += 23) {
    for (let x = alpine.centerX - alpine.outerRadius; x < alpine.centerX + alpine.outerRadius; x += 23) {
      const px = x + random() * 15, pz = z + random() * 15;
      const distance = alpineDistance(px, pz, alpine), y = terrain.sampleHeight(px, pz);
      if (distance > alpine.outerBlendStart || y < alpine.treeLine || y > alpine.basinHeight + 28 || random() > 0.65) continue;
      const slope = Math.hypot(terrain.sampleHeight(px + 2, pz) - y, terrain.sampleHeight(px, pz + 2) - y) / 2;
      if (!Number.isFinite(y) || slope > 0.55) continue;
      // Keep crowns as well as trunks outside the walking corridor.
      if ([-4, 0, 4].some(dx => [-4, 0, 4].some(dz => paths.sample(px + dx, pz + dz) > 0.01))) continue;
      result.push([px, y, pz, random() * Math.PI * 2, 0.7 + random() * 0.55, random() < 0.55 ? 9 : 10]);
    }
  }
  return result;
}
