import { fractalNoise, smoothstep } from '../grass/vegetationEcology.js';

export function resolveAlpineConfig(config) {
  const alpine = config.terrain?.alpine;
  if (!alpine?.enabled) return null;
  return {
    centerX: Number(alpine.center[0]),
    centerZ: Number(alpine.center[1]),
    basinRadius: Number(alpine.basinRadius),
    basinHeight: Number(alpine.basinHeight),
    basinRelief: Number(alpine.basinRelief),
    rimRadius: Number(alpine.rimRadius),
    rimWidth: Number(alpine.rimWidth),
    rimHeight: Number(alpine.rimHeight),
    outerBlendStart: Number(alpine.outerBlendStart),
    outerRadius: Number(alpine.outerRadius),
    angularPeaks: Number(alpine.angularPeaks),
    angularVariation: Number(alpine.angularVariation),
    angularPhase: Number(alpine.angularPhase),
    detailScale: Number(alpine.detailScale),
    detailAmplitude: Number(alpine.detailAmplitude),
    detailOctaves: Number(alpine.detailOctaves),
    seed: Number(alpine.seed),
    refineRadius: Number(alpine.refineRadius),
    refinePasses: Number(alpine.refinePasses),
    treeLine: Number(alpine.treeLine),
    treeClearRadius: Number(alpine.treeClearRadius),
    route: alpine.route,
    landform: resolveLandform(alpine.landform),
  };
}

// Geological structure on the cirque walls; each term is zero when omitted.
function resolveLandform(landform = {}) {
  const block = (value, keys) => Object.fromEntries(keys.map(key => [key, Number(value?.[key] ?? 0)]));
  return {
    couloirs: block(landform.couloirs, ['amplitude', 'spacing', 'meander']),
    strata: block(landform.strata, ['strength', 'bandHeight', 'tilt', 'coverage']),
    crest: block(landform.crest, ['amplitude', 'scale']),
  };
}

const ridged = (x, z, seed, octaves) => 1 - Math.abs(fractalNoise(x, z, seed, octaves) * 2 - 1);

// Couloirs and spurs run down the fall line of both flanks, rock bands step the
// upper walls into snow ledges and rock risers, and the crest breaks into
// notches and pinnacles. None of it reaches the basin floor, so the walkable
// summit stays as it was.
function alpineLandform(x, z, height, distance, angle, rimProfile, wallHeight, alpine) {
  const { couloirs, strata, crest } = alpine.landform;
  const flank = smoothstep(0.06, 0.3, rimProfile) * (1 - smoothstep(0.82, 1, rimProfile) * 0.6)
    * smoothstep(alpine.basinRadius * 0.9, alpine.basinRadius + 20, distance);
  let result = height;
  if (couloirs.amplitude > 0 && couloirs.spacing > 0 && flank > 0) {
    // Constant along the radius (with a slow meander), varying around the ring,
    // so the gullies run straight downhill.
    const around = angle * alpine.rimRadius / couloirs.spacing
      + Math.sin(distance * 0.035 + angle * 3) * couloirs.meander;
    const spur = ridged(around, distance * 0.012, alpine.seed + 71, 2);
    result += (spur - 0.55) * 2 * couloirs.amplitude * flank * Math.min(1, wallHeight / 60);
  }
  if (crest.amplitude > 0 && crest.scale > 0) {
    const crestMask = smoothstep(0.6, 0.95, rimProfile);
    result += (ridged(x * crest.scale, z * crest.scale, alpine.seed + 29, 3) - 0.45) * 2 * crest.amplitude * crestMask;
  }
  if (strata.strength > 0 && strata.bandHeight > 0) {
    // Bands tilt and pinch out, and only some stretches of wall carry them.
    const patch = smoothstep(0.5 - strata.coverage * 0.5, 0.62 - strata.coverage * 0.5,
      fractalNoise(angle * 3.2 + 11, distance * 0.004, alpine.seed + 5, 2));
    const wall = smoothstep(0.25, 0.5, rimProfile) * (1 - smoothstep(0.9, 1, rimProfile)) * patch;
    if (wall > 0) {
      // Thick and thin beds alternate around the ring.
      const band = strata.bandHeight * (0.7 + 0.6 * fractalNoise(angle * 1.7 + 3, 0.5, alpine.seed + 17, 2));
      const phase = (fractalNoise(x * 0.012, z * 0.012, alpine.seed + 13, 2) - 0.5) * strata.tilt * band;
      const t = (result + phase) / band;
      const step = Math.floor(t) + smoothstep(0.55, 0.95, t - Math.floor(t));
      result += (step * band - phase - result) * strata.strength * wall;
    }
  }
  return result;
}

export function alpineDistance(x, z, alpine) {
  return Math.hypot(x - alpine.centerX, z - alpine.centerZ);
}

export function shapeAlpineHeight(x, z, currentHeight, alpine) {
  if (!alpine) return currentHeight;
  const dx = x - alpine.centerX;
  const dz = z - alpine.centerZ;
  const distance = Math.hypot(dx, dz);
  if (distance >= alpine.outerRadius) return currentHeight;

  const angle = Math.atan2(dz, dx);
  const basinT = Math.min(1, distance / alpine.basinRadius);
  const basin = alpine.basinHeight + basinT * basinT * alpine.basinRelief;
  const rimDistance = (distance - alpine.rimRadius) / alpine.rimWidth;
  const rimProfile = Math.exp(-rimDistance * rimDistance);
  const primary = Math.sin(angle * alpine.angularPeaks + alpine.angularPhase);
  const secondary = Math.sin(angle * (alpine.angularPeaks + 2) - alpine.angularPhase * 0.7);
  const angular = 1 + alpine.angularVariation * (primary * 0.68 + secondary * 0.32);
  const detailWeight = 0.18 + smoothstep(alpine.basinRadius * 0.45, alpine.rimRadius, distance) * 0.82;
  const detail = (fractalNoise(
    x * alpine.detailScale,
    z * alpine.detailScale,
    alpine.seed,
    alpine.detailOctaves,
  ) - 0.5) * 2 * alpine.detailAmplitude * detailWeight;
  const targetHeight = alpineLandform(x, z, basin + rimProfile * alpine.rimHeight * angular + detail,
    distance, angle, rimProfile, alpine.rimHeight * angular, alpine);
  const blend = 1 - smoothstep(alpine.outerBlendStart, alpine.outerRadius, distance);
  return currentHeight + (targetHeight - currentHeight) * blend;
}

// Snow coverage above which broadleaf trees give way to snow-laden conifers.
export const ALPINE_CONIFER_SNOW = 0.35;

export function alpineTreeAllowed(x, y, z, alpine, snow = 0) {
  if (!alpine) return true;
  if (alpineDistance(x, z, alpine) > alpine.treeClearRadius) return true;
  return y < alpine.treeLine && snow < ALPINE_CONIFER_SNOW;
}
