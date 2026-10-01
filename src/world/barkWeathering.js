import {
  color, dot, float, fract, materialColor, mix, normalWorld, positionWorld, texture, vec2, vec3,
} from 'three/tsl';
import { getSurfaceDetail } from '../rendering/surfaceDetail.js';
import { noise2 } from './snowNoiseNodes.js';

const MOSS = '#7d9a3a';
const MOSS_DARK = '#4a6123';
// Moss favours the shaded side: north is -Z in this world.
const SHADED_SIDE = [0, 0, -1];
// Metres up the trunk over which moss thins out.
const MOSS_REACH = 6;
const WET_DARKENING = 0.45;
const BASE_TINT = [0.62, 0.58, 0.5];

/**
 * Weathers a tree's bark in the shader, for any tree system:
 * - moss on the shaded (north) side and on upward faces, in broken patches,
 *   thickest near the ground;
 * - rain-darkened bark, wettest in streaks running down the trunk;
 * - snow on upward faces of branches and trunks up in snow country;
 * - a per-tree colour drift, so neighbouring copies of one model differ;
 * - an earthy, darker base where the trunk meets the ground.
 * Height above the ground comes from the terrain heightfield, so it works the
 * same for full, LOD and instanced trees. `seed` is a 0..1 node that differs
 * per tree; `terrain` the TerrainSampler shader data (or null); `base` the
 * bark colour node (the material's own colour by default).
 */
export function weatherBark(material, config, { seed, terrain = null, base = null }) {
  const detail = getSurfaceDetail(config);
  const settings = detail.settings;
  if (!settings.enabled) return material;
  const bark = (base ?? material.colorNode ?? materialColor).rgb;

  let height = float(2);
  if (terrain?.texture) {
    const terrainUv = positionWorld.xz.sub(vec2(terrain.boundsMin.x, terrain.boundsMin.z))
      .div(vec2(terrain.boundsSize.x, terrain.boundsSize.z)).clamp(0, 1);
    const ground = texture(terrain.texture, terrainUv).level(0).r
      .mul(terrain.maxHeight - terrain.minHeight).add(terrain.minHeight);
    height = positionWorld.y.sub(ground).max(0);
  }
  const world = positionWorld;
  // Around the trunk rather than across the world, so patches wrap it.
  const around = world.x.add(world.z);

  const tint = mix(vec3(1.07, 1.0, 0.9), vec3(0.9, 0.95, 1.04), seed);
  const tinted = mix(bark, bark.mul(tint), detail.barkTint.mul(4));

  const patches = noise2(vec2(around.mul(0.9), world.y.mul(0.6)).add(seed.mul(19))).smoothstep(-0.15, 0.35);
  const facing = dot(normalWorld, vec3(...SHADED_SIDE)).max(0).mul(0.7).add(normalWorld.y.max(0).mul(0.8));
  const low = height.smoothstep(0, MOSS_REACH).oneMinus().mul(0.6).add(0.4);
  const snowLine = config.ground?.snow?.enabled && config.ground.snow.altitude
    ? world.y.smoothstep(config.ground.snow.altitude.start, config.ground.snow.altitude.full)
    : float(0);
  const moss = facing.mul(patches).mul(low).mul(snowLine.oneMinus()).mul(detail.barkMoss).clamp(0, 1);
  const mossColor = mix(color(MOSS_DARK), color(MOSS), fract(seed.mul(3.1))).mul(dot(bark, vec3(0.3, 0.59, 0.11)).mul(1.2).add(0.6));
  const mossy = mix(tinted, mossColor, moss);

  // Earthy base where soil splashes and damp wick up the trunk.
  const baseShade = height.smoothstep(0, settings.bark.baseHeight).oneMinus().mul(detail.barkBase);
  const grounded = mix(mossy, mossy.mul(vec3(...BASE_TINT)), baseShade);

  // Rain: water runs down in streaks, so the bark darkens unevenly.
  const runs = noise2(vec2(around.mul(2.4), world.y.mul(0.18)).add(seed.mul(7))).smoothstep(-0.4, 0.4).mul(0.6).add(0.4);
  const wet = detail.rain.mul(detail.barkWet).mul(runs);
  const soaked = grounded.mul(wet.mul(WET_DARKENING).oneMinus());

  // Snow caught on the upward faces up in snow country.
  const snowFaces = normalWorld.y.smoothstep(0.3, 0.7).mul(patches.mul(0.5).add(0.5));
  const snow = snowFaces.mul(snowLine).mul(detail.barkSnow);
  material.colorNode = mix(soaked, color(config.ground?.snow?.colors?.base ?? '#e4eaf1'), snow);
  return material;
}

/**
 * A 0..1 per-tree seed from the tree's appearance tint, which every tree
 * system already carries per tree and keeps the same across its LOD levels.
 */
export function tintSeed(tint) {
  return fract(dot(tint, vec3(7.13, 13.37, 3.71)).mul(19.1).sin().mul(43758.5453));
}
