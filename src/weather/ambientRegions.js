import * as THREE from 'three';
import { float, max, smoothstep } from 'three/tsl';
import { coastDistanceAt, coastXNode, resolveCoastConfig, sampleSandCoverageCpu } from '../world/CoastField.js';
import { coastalJungleProfileWeight } from '../world/CoastalJungleRegion.js';
import { lakeSignedDistance, resolveLakeShape } from '../world/LakeShape.js';

// Where each ambient effect belongs. Every region has two halves that agree
// with each other: a CPU weight at the view's focus, which switches a whole
// particle field on or off, and a per-particle GPU mask, so a field straddling
// a border (the beach meeting the meadow, the snow line) only shows on its own
// side of it.
export const REGION_NAMES = Object.freeze(['any', 'snow', 'sand', 'surf', 'jungle', 'water', 'lake', 'meadow']);

// The focus weight looks this far around the focus as well, so a field fades
// in while its region comes into view rather than when the player steps in.
const LOOKAROUND = 28;
const LOOK_OFFSETS = Object.freeze([[0, 0], [LOOKAROUND, 0], [-LOOKAROUND, 0], [0, LOOKAROUND], [0, -LOOKAROUND]]);
// The breakers run along this band of signed coast distance (positive seaward).
const SURF_BAND = Object.freeze({ inner: 6, innerFull: 18, outerFull: 36, outer: 66 });
// Blowing sand keeps to the open beach: the inland edge of full sand cover,
// less this reach, to a little past it.
const SAND_EDGE = Object.freeze({ inland: 25, full: 5 });
// Surf is visible from the whole beach, not just the waterline.
const SURF_VIEW = Object.freeze({ full: 90, none: 220 });
const WATER_VIEW = Object.freeze({ full: 12, none: 55 });
const LAKE_VIEW = Object.freeze({ full: 40, none: 160 });

function smooth(value, edge0, edge1) {
  return THREE.MathUtils.smoothstep(value, edge0, edge1);
}

/**
 * Pure description of the regions, resolved once from the merged config.
 * `snowLine` is the snow-country band from ground.snow.atmosphere.
 */
export function resolveAmbientRegions(config) {
  const sea = config.water?.sea?.enabled ? resolveCoastConfig(config.water.sea) : null;
  const atmosphere = config.ground?.snow?.enabled ? config.ground.snow.atmosphere : null;
  const jungle = config.biomes?.coastalJungle;
  const region = jungle?.enabled && sea ? jungle.region : null;
  let lake = null;
  try {
    lake = resolveLakeShape(config);
  } catch {
    lake = null;
  }
  return {
    config,
    sea,
    snowLine: atmosphere ? { start: Number(atmosphere.startHeight), full: Number(atmosphere.fullHeight) } : null,
    jungle: region ? {
      zMin: Math.min(region.zStart, region.zEnd),
      zMax: Math.max(region.zStart, region.zEnd),
      inlandMin: Math.min(region.inlandStart, region.inlandEnd),
      inlandMax: Math.max(region.inlandStart, region.inlandEnd),
      edge: Math.max(0, Number(jungle.ecology?.edgeFade ?? 18)),
    } : null,
    lake,
    lakeLevel: lake?.level ?? Number(config.water?.position?.[1] ?? -Infinity),
  };
}

/**
 * Region weights at a focus point, each 0..1. `snowWeight` is the eased
 * snow-country weight the environment already tracks; `river` is the
 * RiverCourse (or null) and `sampleHeight(x, z)` the terrain height.
 */
export function sampleAmbientRegions(regions, x, z, { snowWeight = 0, river = null, sampleHeight = null } = {}) {
  const snow = THREE.MathUtils.clamp(Number(snowWeight) || 0, 0, 1);
  let sand = 0;
  let jungle = 0;
  const y = sampleHeight ? sampleHeight(x, z) : 0;
  if (regions.sea) {
    for (const [dx, dz] of LOOK_OFFSETS) {
      const px = x + dx;
      const pz = z + dz;
      const ground = sampleHeight ? sampleHeight(px, pz) : y;
      const { coverage, dryness } = sampleSandCoverageCpu(px, ground, pz, regions.config);
      sand = Math.max(sand, coverage * (0.35 + 0.65 * dryness));
      if (regions.jungle) jungle = Math.max(jungle, coastalJungleProfileWeight(px, pz, regions.config));
    }
  }
  const surf = regions.sea
    ? 1 - smooth(Math.abs(coastDistanceAt(x, z, regions.sea)), SURF_VIEW.full, SURF_VIEW.none)
    : 0;
  const lakeDistance = regions.lake ? lakeSignedDistance(x, z, regions.lake) : Infinity;
  const riverEdge = river?.sample?.(x, z)?.edge ?? Infinity;
  const water = 1 - smooth(Math.min(lakeDistance, riverEdge), WATER_VIEW.full, WATER_VIEW.none);
  const lake = 1 - smooth(lakeDistance, LAKE_VIEW.full, LAKE_VIEW.none);
  const meadow = (1 - snow) * (1 - jungle) * (1 - sand);
  return { any: 1, snow, sand, surf, jungle, water, lake, meadow };
}

/** The largest of the named weights. */
export function regionWeight(weights, names) {
  let best = 0;
  for (const name of names) best = Math.max(best, weights[name] ?? 0);
  return best;
}

// GPU masks, built from the particle's world x/z and the ground under it.
function snowMask(regions, ground) {
  if (!regions.snowLine) return float(0);
  return smoothstep(regions.snowLine.start, regions.snowLine.full, ground);
}

function sandMask(regions, x, z, ground) {
  if (!regions.sea) return float(0);
  const { sand } = regions.sea.coast;
  const distance = x.sub(coastXNode(z, regions.sea));
  return smoothstep(sand.inlandEnd - SAND_EDGE.inland, sand.inlandEnd + SAND_EDGE.full, distance)
    .mul(smoothstep(regions.sea.level + 0.1, regions.sea.level + 0.6, ground));
}

function surfMask(regions, x, z) {
  if (!regions.sea) return float(0);
  const distance = x.sub(coastXNode(z, regions.sea));
  return smoothstep(SURF_BAND.inner, SURF_BAND.innerFull, distance)
    .mul(smoothstep(SURF_BAND.outerFull, SURF_BAND.outer, distance).oneMinus());
}

function jungleMask(regions, x, z) {
  const jungle = regions.jungle;
  if (!jungle) return float(0);
  const inland = coastXNode(z, regions.sea).sub(x);
  const zFade = Math.max(1e-3, Math.min(jungle.edge, (jungle.zMax - jungle.zMin) * 0.5));
  const inlandFade = Math.max(1e-3, Math.min(jungle.edge, (jungle.inlandMax - jungle.inlandMin) * 0.5));
  return smoothstep(jungle.zMin, jungle.zMin + zFade, z)
    .mul(smoothstep(jungle.zMax - zFade, jungle.zMax, z).oneMinus())
    .mul(smoothstep(jungle.inlandMin, jungle.inlandMin + inlandFade, inland))
    .mul(smoothstep(jungle.inlandMax - inlandFade, jungle.inlandMax, inland).oneMinus());
}

function lakeMask(regions, ground) {
  if (!Number.isFinite(regions.lakeLevel)) return float(0);
  return smoothstep(0.3, 1.2, float(regions.lakeLevel).sub(ground));
}

/** Per-particle mask node for a list of region names (their maximum). */
export function createRegionMaskNode(regions, names, x, z, ground) {
  const masks = names.map((name) => {
    switch (name) {
      case 'snow': return snowMask(regions, ground);
      case 'sand': return sandMask(regions, x, z, ground);
      case 'surf': return surfMask(regions, x, z);
      case 'jungle': return jungleMask(regions, x, z);
      case 'lake': return lakeMask(regions, ground);
      case 'meadow': return snowMask(regions, ground).oneMinus()
        .mul(sandMask(regions, x, z, ground).oneMinus())
        .mul(jungleMask(regions, x, z).oneMinus());
      default: return float(1);
    }
  });
  return masks.slice(1).reduce((result, mask) => max(result, mask), masks[0] ?? float(1));
}
