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
  };
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
  const targetHeight = basin + rimProfile * alpine.rimHeight * angular + detail;
  const blend = 1 - smoothstep(alpine.outerBlendStart, alpine.outerRadius, distance);
  return currentHeight + (targetHeight - currentHeight) * blend;
}

export function alpineTreeAllowed(x, y, z, alpine) {
  if (!alpine) return true;
  if (alpineDistance(x, z, alpine) > alpine.treeClearRadius) return true;
  return y < alpine.treeLine;
}
