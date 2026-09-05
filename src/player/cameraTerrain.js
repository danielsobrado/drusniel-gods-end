const DEFAULT_TERRAIN_CLEARANCE = 0.4;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clampCameraAboveTerrain(position, terrainSampler, clearance = DEFAULT_TERRAIN_CLEARANCE) {
  if (!position || typeof terrainSampler?.sampleHeight !== 'function') return position;

  if (
    typeof terrainSampler.contains === 'function'
    && !terrainSampler.contains(position.x, position.z, 0)
  ) {
    return position;
  }

  const groundHeight = terrainSampler.sampleHeight(position.x, position.z);
  if (!Number.isFinite(groundHeight)) return position;

  const safeClearance = Math.max(0, finiteNumber(clearance, DEFAULT_TERRAIN_CLEARANCE));
  position.y = Math.max(position.y, groundHeight + safeClearance);
  return position;
}
