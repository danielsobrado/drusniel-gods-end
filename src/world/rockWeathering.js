import { MeshStandardNodeMaterial } from 'three/webgpu';
import { characterOcclusionKeep } from '../rendering/CharacterOcclusion.js';
import { color, dot, float, mix, normalMap, normalView, normalWorld, normalize, positionWorld, sin, texture, uv, vec2, vec3 } from 'three/tsl';
import { getSurfaceDetail } from '../rendering/surfaceDetail.js';
import { noise2 } from './snowNoiseNodes.js';

// The stylized rock pack's albedo is near-white and uniform, so stones read as
// plastic set on the grass. Weather them in the shader: moss settles on the
// upward faces in broken patches, undersides fall into the ground's shade, and
// the bare albedo is toned down to sit with the terrain. A few ALU ops, no
// extra textures.
const MOSS = '#7d9a3a';
const MOSS_DARK = '#4d6424';
const DUST = '#a89a80';
const WET_DARKENING = 0.5;

// `config` (optional) enables the surface-detail waterline and dust.
export function createWeatheredRockMaterial(source, { toning = 0.72, moss = 0.85 } = {}, config = null) {
  const material = new MeshStandardNodeMaterial();
  material.name = `${source.name || 'Rock'} (weathered)`;
  for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'side', 'roughness', 'metalness']) {
    if (source[key] !== undefined) material[key] = source[key];
  }
  if (source.normalScale) material.normalScale.copy(source.normalScale);
  material.color.copy(source.color);

  // Broad tonal breakup from world-space sine products, so stones sharing a
  // template no longer read as copies.
  const p = positionWorld;
  const tone = sin(p.x.mul(0.83).add(sin(p.y.mul(1.31)).mul(1.6)))
    .mul(sin(p.z.mul(0.97).add(sin(p.x.mul(0.61)).mul(1.2))))
    .mul(sin(p.y.mul(0.71).add(p.z.mul(0.37)))).mul(0.5).add(0.5);
  const albedo = (source.map ? texture(source.map, uv()).rgb : vec3(1)).mul(color(source.color))
    .mul(toning).mul(mix(0.74, 1.06, tone));
  const world = positionWorld.xz;
  const patches = sin(world.x.mul(0.9).add(sin(world.y.mul(0.7)).mul(1.8)))
    .mul(sin(world.y.mul(1.1).add(sin(world.x.mul(0.5)).mul(1.4)))).mul(0.5).add(0.5);
  const up = normalWorld.y;
  const snow = config?.ground?.snow;
  const snowBand = snow?.enabled ? positionWorld.y.smoothstep(snow.altitude.start, snow.altitude.full) : float(0);
  const mossMask = up.smoothstep(0.35, 0.85).mul(patches.smoothstep(0.25, 0.7)).mul(moss)
    .mul(snowBand.oneMinus());
  const shade = dot(albedo, vec3(0.3, 0.59, 0.11)).mul(0.9).add(0.55);
  const mossColor = mix(color(MOSS_DARK), color(MOSS), patches).mul(shade);
  const underside = up.smoothstep(-0.7, 0.15).mul(0.45).add(0.55);
  let weathered = mix(albedo, mossColor, mossMask).mul(underside);
  let roughness = source.roughnessMap
    ? texture(source.roughnessMap, uv()).g.mul(source.roughness ?? 1).max(mossMask.mul(0.95))
    : float(source.roughness ?? 0.85).max(mossMask.mul(0.95));
  const detail = config ? getSurfaceDetail(config) : null;
  if (detail?.settings.enabled) {
    // Dust settles on the bare tops the moss has not claimed.
    const dust = up.smoothstep(0.55, 0.95).mul(mossMask.oneMinus()).mul(patches.oneMinus()).mul(detail.propDust);
    weathered = mix(weathered, color(DUST).mul(shade), dust);
    // Stones standing in the lake or the sea are wet (dark, glossy) up to a
    // ragged splash line.
    const height = detail.settings.props.height;
    const splash = noise2(world.mul(0.7)).mul(0.5).add(0.5).mul(height);
    const levels = [Number(config.water?.position?.[1])];
    if (config.water?.sea?.enabled) levels.push(Number(config.water.sea.level));
    const wet = levels.filter(Number.isFinite)
      .map((level) => positionWorld.y.sub(level).smoothstep(splash.mul(0.6), splash.add(0.15)).oneMinus()
        .mul(positionWorld.y.sub(level).smoothstep(-2, -0.5)))
      .reduce((result, band) => result.max(band), float(0))
      .mul(detail.propWaterline);
    weathered = weathered.mul(wet.mul(WET_DARKENING).oneMinus());
    roughness = mix(roughness, float(0.25), wet);
  }
  if (snow?.enabled) {
    // Snow rests on upward faces; the broken edge follows the rock's existing
    // patch field. Steep sides and undersides retain their exposed stone.
    const edge = patches.sub(0.5).mul(0.16);
    const cap = up.smoothstep(edge.add(snow.slope.start), edge.add(snow.slope.full)).mul(snowBand);
    const powder = mix(color(snow.colors.shadow), color(snow.colors.base), up.smoothstep(0.4, 0.95))
      .mul(patches.mul(0.06).add(0.97));
    weathered = mix(weathered, powder, cap);
    roughness = mix(roughness, float(snow.roughness.base), cap);
    if (source.normalMap) {
      const scale = source.normalScale ?? { x: 1, y: 1 };
      const rockNormal = normalMap(texture(source.normalMap).rgb, vec2(scale.x, scale.y));
      material.normalNode = normalize(mix(rockNormal, normalView, cap.mul(0.85)));
    }
  }
  material.colorNode = weathered;
  material.roughnessNode = roughness;
  // Dithered away in front of the character, like foliage.
  material.maskNode = characterOcclusionKeep();
  return material;
}
