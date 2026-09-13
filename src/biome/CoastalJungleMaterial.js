import * as THREE from 'three/webgpu';
import {
  Fn,
  cos,
  float,
  instanceIndex,
  positionLocal,
  sin,
  smoothstep,
  texture,
  time,
  uv,
  vec3,
} from 'three/tsl';
import { foliageBacklight } from '../rendering/CinematicLighting.js';
import { getSharedWindUniforms } from '../weather/WindField.js';

const COLOR_TEXTURE_KEYS = new Set(['map', 'emissiveMap', 'sheenColorMap', 'specularColorMap']);
const FOLIAGE_NAME_HINTS = ['atlas', 'leaf', 'frond', 'fern', 'grass', 'groundcover', 'shrub'];
const FOLIAGE_KINDS = new Set([
  'grass',
  'groundcover',
  'fern',
  'broadleaf',
  'palm',
  'tree',
  'shrub',
  'vine',
  'climber',
  'background_tree',
  'split_leaf',
]);
const DEG_TO_RAD = Math.PI / 180;
const INSTANCE_PHASE = 0.754877666;

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, numberOr(value, 0)));
}

export function isCoastalJungleFoliageMaterial(material, kind = null) {
  const name = String(material?.name ?? '').toLowerCase();
  if (name.includes('atlas')) return true;
  if (!FOLIAGE_KINDS.has(kind)) return false;
  return FOLIAGE_NAME_HINTS.some((hint) => name.includes(hint));
}

export function prepareCoastalJungleTexture(textureValue, {
  anisotropy = 8,
  colorTexture = false,
} = {}) {
  if (!textureValue?.isTexture) return textureValue;
  textureValue.generateMipmaps = true;
  textureValue.minFilter = THREE.LinearMipmapLinearFilter;
  textureValue.magFilter = THREE.LinearFilter;
  textureValue.anisotropy = Math.max(textureValue.anisotropy ?? 1, Math.max(1, Number(anisotropy) || 1));
  if (colorTexture) textureValue.colorSpace = THREE.SRGBColorSpace;
  textureValue.needsUpdate = true;
  return textureValue;
}

function prepareMaterialTextures(material, anisotropy) {
  for (const [key, value] of Object.entries(material ?? {})) {
    if (!value?.isTexture) continue;
    prepareCoastalJungleTexture(value, {
      anisotropy,
      colorTexture: COLOR_TEXTURE_KEYS.has(key),
    });
  }
}

function createWindPosition(kind, instanced, settings) {
  const wind = settings.wind ?? {};
  const shared = getSharedWindUniforms();
  const amplitude = Math.max(0, numberOr(wind.amplitude, 0.035));
  const speed = Math.max(0, numberOr(wind.speed, 1.4));
  const spatialX = numberOr(wind.spatialX, 0.7);
  const spatialZ = numberOr(wind.spatialZ, 0.6);
  const turbulence = clamp01(wind.turbulence ?? 0.28);
  const flutterRatio = clamp01(wind.flutterRatio ?? 0.32);
  const kindScale = Math.max(0, numberOr(wind.kindScale?.[kind], 1));
  const instancePhase = instanced ? float(instanceIndex).mul(INSTANCE_PHASE) : float(0);
  const phase = time.mul(shared.simulationSpeed).mul(speed)
    .add(positionLocal.x.mul(spatialX))
    .add(positionLocal.z.mul(spatialZ))
    .add(instancePhase);
  const heightWeight = smoothstep(0, 1, positionLocal.y.abs());
  const primary = sin(phase).mul(1 - turbulence);
  const secondary = sin(phase.mul(0.47).add(instancePhase.mul(0.31))).mul(turbulence);
  const flutter = sin(phase.mul(2.13).add(instancePhase)).mul(flutterRatio);
  const strength = amplitude * kindScale;
  const bend = primary.add(secondary).mul(strength).mul(heightWeight);
  const cross = flutter.mul(strength * 0.35).mul(heightWeight);
  const angle = shared.directionDegrees.mul(DEG_TO_RAD);
  const dirX = cos(angle);
  const dirZ = sin(angle);
  const offset = vec3(
    dirX.mul(bend).sub(dirZ.mul(cross)),
    0,
    dirZ.mul(bend).add(dirX.mul(cross)),
  );
  return positionLocal.add(offset);
}

export function prepareCoastalJungleMaterial(material, {
  kind = null,
  instanced = false,
  surface = false,
  settings = {},
  anisotropy = 8,
  cinematic = false,
} = {}) {
  if (!material) return material;
  prepareMaterialTextures(material, anisotropy);

  const foliage = !surface && isCoastalJungleFoliageMaterial(material, kind);
  if (!foliage) {
    if (surface) {
      const minimum = Math.max(0, Math.min(1, numberOr(settings.surfaceRoughnessMin, 0.9)));
      material.roughness = Math.max(numberOr(material.roughness, minimum), minimum);
      material.metalness = 0;
      material.needsUpdate = true;
    }
    return material;
  }

  const alphaTest = clamp01(settings.alphaTest ?? 0.4);
  const shadowAlphaTest = clamp01(settings.shadowAlphaTest ?? alphaTest);
  const roughnessMin = clamp01(settings.foliageRoughnessMin ?? 0.82);
  const ambientLift = clamp01(settings.ambientLift ?? 0.035);
  const backlight = clamp01(settings.backlight ?? 0.18);

  material.side = THREE.DoubleSide;
  material.shadowSide = THREE.DoubleSide;
  material.transparent = false;
  material.depthWrite = true;
  material.alphaTest = alphaTest;
  material.alphaTestNode = float(alphaTest);
  material.alphaToCoverage = Boolean(settings.alphaToCoverage ?? cinematic);
  material.roughness = Math.max(numberOr(material.roughness, roughnessMin), roughnessMin);
  material.metalness = 0;
  material.fog = true;
  material.dithering = true;

  if (material.map) {
    const sample = texture(material.map, uv());
    material.emissiveNode = sample.rgb.mul(float(ambientLift))
      .add(foliageBacklight(sample.rgb, backlight));
    material.maskShadowNode = Fn(() => texture(material.map, uv()).a.greaterThan(shadowAlphaTest))();
  }

  if (settings.wind?.enabled !== false) {
    material.positionNode = createWindPosition(kind, instanced, settings);
  }

  material.userData.coastalJungleFoliage = true;
  material.needsUpdate = true;
  return material;
}
