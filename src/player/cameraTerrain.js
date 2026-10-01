const DEFAULT_TERRAIN_CLEARANCE = 0.4;
const DEFAULT_OCCLUSION_SAMPLES = 16;
const DEFAULT_OCCLUSION_PADDING = 0.25;
const BINARY_SEARCH_STEPS = 5;
const LIFT_MARGIN = 0.05;

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

/**
 * Raises `position` until its line of sight to `target` clears the terrain by
 * `clearance`, so on a slope the camera rides up over the ground rather than
 * being pulled into the character. The rise stops at `maxElevationDegrees`
 * above the target (then constrainCameraLineOfSight shortens the boom).
 * Samples start `nearFraction` along the line: the ground right under the
 * target is the character's own footing. The line is lifted `LIFT_MARGIN`
 * past `clearance`: constrainCameraLineOfSight tests the same samples against
 * `clearance`, and a line lifted to exactly that height passed or failed it
 * on floating-point noise, so an idle camera kept snapping in and easing out.
 */
export function liftCameraOverTerrain(
  position,
  target,
  terrainSampler,
  { clearance = DEFAULT_TERRAIN_CLEARANCE, samples = DEFAULT_OCCLUSION_SAMPLES, maxElevationDegrees = 62, nearFraction = 0.2 } = {},
) {
  if (!position || !target || typeof terrainSampler?.sampleHeight !== 'function') return position;
  const dx = position.x - target.x;
  const dz = position.z - target.z;
  const horizontal = Math.hypot(dx, dz);
  if (!(horizontal > 1e-3)) return position;
  const safeClearance = Math.max(0, finiteNumber(clearance, DEFAULT_TERRAIN_CLEARANCE)) + LIFT_MARGIN;
  const count = Math.max(2, Math.round(finiteNumber(samples, DEFAULT_OCCLUSION_SAMPLES)));
  let needed = position.y;
  for (let index = 1; index <= count; index += 1) {
    const t = nearFraction + (1 - nearFraction) * (index / count);
    const ground = safeSampleHeight(terrainSampler, target.x + dx * t, target.z + dz * t);
    if (ground === null) continue;
    // The line's height at t is target.y + (y - target.y) * t.
    needed = Math.max(needed, target.y + (ground + safeClearance - target.y) / t);
  }
  const ceiling = target.y + horizontal * Math.tan((finiteNumber(maxElevationDegrees, 62) * Math.PI) / 180);
  position.y = Math.max(position.y, Math.min(needed, ceiling));
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
    // Share of the line next to the target that is not tested: on a steep
    // slope the character's own footing rises past a shoulder-height target,
    // and counting it pulled the camera into the character.
    nearFraction = 0,
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
  const near = Math.min(0.9, Math.max(0, finiteNumber(nearFraction, 0)));
  let previousT = near;

  const blocked = (t) => {
    const x = target.x + dx * t;
    const y = target.y + dy * t;
    const z = target.z + dz * t;
    const groundHeight = safeSampleHeight(terrainSampler, x, z);
    return groundHeight !== null && y < groundHeight + safeClearance;
  };

  for (let index = 1; index <= sampleCount; index += 1) {
    const t = near + (1 - near) * (index / sampleCount);
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
