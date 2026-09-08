export function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

export function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function hashInteger(value) {
  let x = value | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}

export function hash2d(x, z, seed) {
  const mixed = hashInteger((x | 0) ^ Math.imul(z | 0, 0x27d4eb2d) ^ (seed | 0));
  return mixed / 4294967295;
}

function valueNoise(x, z, seed) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smoothstep(0, 1, x - x0);
  const tz = smoothstep(0, 1, z - z0);
  const a = hash2d(x0, z0, seed);
  const b = hash2d(x0 + 1, z0, seed);
  const c = hash2d(x0, z0 + 1, seed);
  const d = hash2d(x0 + 1, z0 + 1, seed);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * tz;
}

export function fractalNoise(x, z, seed, octaves) {
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;
  let weight = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += valueNoise(x * frequency, z * frequency, seed + octave * 1013) * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return weight > 0 ? total / weight : 0;
}

export function computeVegetationEcology(input, config) {
  const habitat = input.submerged ? 0 : 1;
  const path = 1 - smoothstep(
    config.path.clearance,
    config.path.clearance + config.path.falloff,
    input.pathDistance,
  );
  const slope = smoothstep(config.terrain.slopeStart, config.terrain.slopeMax, input.slope);
  const slopeSuitability = 1 - slope;
  const water = 1 - smoothstep(0, config.moisture.waterDistance, input.waterDistance);
  const lowland = Math.pow(1 - clamp01(input.height01), config.moisture.lowlandExponent);
  const moisture = clamp01(
    water * config.moisture.waterWeight
      + lowland * config.moisture.lowlandWeight
      + input.macroNoise * config.moisture.noiseWeight,
  );
  const trunkOpen = smoothstep(
    config.trees.trunkClearance,
    config.trees.trunkClearance + config.trees.trunkFalloff,
    input.nearestTreeDistance,
  );
  const fertility = clamp01(
    config.density.base
      + moisture * config.density.moistureBoost
      + (input.macroNoise - 0.5) * config.density.macroVariation
      + (input.detailNoise - 0.5) * config.density.detailVariation
      - input.height01 * config.density.highlandPenalty,
  );
  const shadeOpen = 1 - input.treeShade * config.trees.grassShadePenalty;
  const density = clamp01(
    fertility * habitat * (1 - path) * slopeSuitability * trunkOpen * shadeOpen,
  );
  const height = clamp01(
    config.height.base
      + input.macroNoise * config.height.macroWeight
      + moisture * config.height.moistureWeight
      - path * config.height.pathPenalty
      - slope * config.height.slopePenalty
      - input.treeShade * config.height.shadePenalty,
  );
  const understory = clamp01(
    (input.treeShade * config.understory.treeWeight + moisture * config.understory.moistureWeight)
      * habitat
      * (1 - path)
      * slopeSuitability,
  );
  const growth = clamp01(density * (
    config.height.minGrowth + height * (config.height.maxGrowth - config.height.minGrowth)
  ));

  return { density, growth, height, moisture, understory, path };
}
