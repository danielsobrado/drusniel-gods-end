const DEFAULT_TERRAIN_CLEARANCE = 0.4;
const DEFAULT_OCCLUSION_SAMPLES = 16;
const DEFAULT_OCCLUSION_PADDING = 0.25;
const BINARY_SEARCH_STEPS = 5;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeSampleHeight(terrainSampler, x, z) {
  if (typeof terrainSampler?.contains === 'function' && !terrainSampler.contains(x, z, 0)) return null;
  const height = terrainSampler?.sampleHeight?.(x, z);
  return Number.isFinite(height) ? height : null;
}

export function clampCameraAboveTerrain(position, terrainSampler, clearance = DEFAULT_TERRAIN_CLEARANCE) {
  if (!position || typeof terrainSampler?.sampleHeight !== 'function') return position;

  const groundHeight = safeSampleHeight(terrainSampler, position.x, position.z);
  if (groundHeight === null) return position;

  const safeClearance = Math.max(0, finiteNumber(clearance, DEFAULT_TERRAIN_CLEARANCE));
  position.y = Math.max(position.y, groundHeight + safeClearance);
  return position;
}

export function constrainCameraLineOfSight(
  position,
  target,
  terrainSampler,
  {
    clearance = DEFAULT_TERRAIN_CLEARANCE,
    samples = DEFAULT_OCCLUSION_SAMPLES,
    padding = DEFAULT_OCCLUSION_PADDING,
  } = {},
) {
  if (!position || !target || typeof terrainSampler?.sampleHeight !== 'function') return position;

  const dx = position.x - target.x;
  const dy = position.y - target.y;
  const dz = position.z - target.z;
  const distance = Math.hypot(dx, dy, dz);
  if (!(distance > 0)) return position;

  const safeClearance = Math.max(0, finiteNumber(clearance, DEFAULT_TERRAIN_CLEARANCE));
  const safePadding = Math.max(0, finiteNumber(padding, DEFAULT_OCCLUSION_PADDING));
  const sampleCount = Math.max(2, Math.round(finiteNumber(samples, DEFAULT_OCCLUSION_SAMPLES)));
  let previousT = 0;

  const blocked = (t) => {
    const x = target.x + dx * t;
    const y = target.y + dy * t;
    const z = target.z + dz * t;
    const groundHeight = safeSampleHeight(terrainSampler, x, z);
    return groundHeight !== null && y < groundHeight + safeClearance;
  };

  for (let index = 1; index <= sampleCount; index += 1) {
    const t = index / sampleCount;
    if (!blocked(t)) {
      previousT = t;
      continue;
    }

    let low = previousT;
    let high = t;
    for (let iteration = 0; iteration < BINARY_SEARCH_STEPS; iteration += 1) {
      const mid = (low + high) * 0.5;
      if (blocked(mid)) high = mid;
      else low = mid;
    }

    const paddedT = Math.max(0, low - safePadding / distance);
    position.set(
      target.x + dx * paddedT,
      target.y + dy * paddedT,
      target.z + dz * paddedT,
    );
    return clampCameraAboveTerrain(position, terrainSampler, safeClearance);
  }

  return clampCameraAboveTerrain(position, terrainSampler, safeClearance);
}
