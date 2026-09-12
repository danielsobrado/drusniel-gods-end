import * as THREE from 'three/webgpu';
import {
  Fn,
  atan,
  attribute,
  cameraPosition,
  float,
  floor,
  fract,
  mix,
  modelWorldMatrix,
  positionGeometry,
  positionLocal,
  smoothstep,
  texture,
  transformNormalToView,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { foliageBacklight } from '../rendering/CinematicLighting.js';
import { createFoliageWind, createSimpleFoliageSway } from '../foliage/foliageWind.js';
import { LEAF_CUTOFF } from './BiomeCatalog.js';
import { biomeCoverage } from './BiomeLod.js';

export function createBiomeMeshMaterial({
  map,
  normalMap,
  roughnessMap,
  metalnessMap,
  normalScale,
  color,
  roughness,
  metalness,
  height,
  radius,
  fadeWidth,
  windIntensity,
  windBend,
  windFlutter,
  cutoff = LEAF_CUTOFF,
  shadowCutoff,
  cinematic,
  config,
  coverage = null,
  tint,
  wind = true,
  backlight = true,
  side = THREE.DoubleSide,
}) {
  const material = new THREE.MeshStandardNodeMaterial();
  material.map = map ?? null;
  material.normalMap = normalMap ?? null;
  material.roughnessMap = roughnessMap ?? null;
  material.metalnessMap = metalnessMap ?? null;
  if (normalScale?.isVector2) material.normalScale.copy(normalScale);
  if (color) material.color.copy(color);
  material.roughness = roughness ?? 0.86;
  material.metalness = metalness ?? 0;
  material.side = side;
  material.transparent = false;
  material.depthWrite = true;
  material.alphaTestNode = float(cutoff);
  material.alphaToCoverage = Boolean(cinematic);
  material.maskNode = coverage;

  const origin = attribute('clumpOrigin', 'vec3');
  const distance = origin.xz.sub(cameraPosition.xz).length();
  const fade = smoothstep(radius.sub(fadeWidth), radius, distance).oneMinus();
  const world = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
  const heightWeight = smoothstep(0, height.mul(0.85), positionGeometry.y.max(0));
  if (wind) {
    const offset = createFoliageWind({ origin, world, distance, heightWeight,
      windIntensity, windBend, windFlutter, config });
    material.positionNode = positionLocal.sub(origin).add(offset).mul(fade).add(origin);
  } else {
    material.positionNode = positionLocal.sub(origin).mul(fade).add(origin);
  }

  if (map) {
    const sample = texture(map, uv());
    const sourcePigment = color ? sample.rgb.mul(vec3(color.r, color.g, color.b)) : sample.rgb;
    const pigment = tint ? sourcePigment.mul(tint) : sourcePigment;
    material.colorNode = vec4(pigment, sample.a);
    if (cinematic && backlight) {
      material.emissiveNode = foliageBacklight(
        pigment,
        config?.cinematic?.vegetation?.backlight ?? 0.28,
      );
    }
    material.maskShadowNode = Fn(() => texture(map, uv()).a.greaterThan(shadowCutoff ?? cutoff))();
  }
  return material;
}

export function createBiomeBillboard({
  atlas, capacity, radius, fadeWidth, windIntensity, windBend, windFlutter, cinematic,
  lodStart, lodEnd, farStart, farEnd, tint, cutoff = LEAF_CUTOFF,
}) {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.translate(0, 0.5, 0);
  geometry.setAttribute('clumpOrigin', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
  geometry.setAttribute('billboardShape', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
  const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.86 });
  material.transparent = false;
  material.depthWrite = true;
  material.alphaTestNode = float(cutoff);
  material.alphaToCoverage = Boolean(cinematic);
  const origin = attribute('clumpOrigin', 'vec3');
  const shape = attribute('billboardShape', 'vec3');
  const toCamera = cameraPosition.xz.sub(origin.xz);
  const toward = toCamera.div(toCamera.length().max(0.001));
  const right = vec3(toward.y, 0, toward.x.negate());
  const distance = toCamera.length();
  const fade = smoothstep(radius.sub(fadeWidth), radius, distance).oneMinus();
  const sway = createSimpleFoliageSway({ origin, heightWeight: positionGeometry.y,
    windIntensity, windBend, windFlutter });
  material.positionNode = origin.add(right.mul(positionGeometry.x.mul(shape.x))
    .add(vec3(0, positionGeometry.y.mul(shape.y), 0)).add(sway).mul(fade));
  const angle = atan(toCamera.x, toCamera.y).sub(shape.z).div(Math.PI * 2);
  const view = fract(angle.add(1)).mul(atlas.views);
  const first = floor(view), second = first.add(1).mod(atlas.views);
  const inset = 0.5 / atlas.tileSize;
  const tileUv = uv().clamp(inset, 1 - inset);
  const sample = (index) => texture(atlas.texture, vec2(tileUv.x.add(index).div(atlas.views), tileUv.y));
  const a = sample(first), b = sample(second), blend = fract(view);
  const alpha = mix(a.a, b.a, blend);
  const rgb = mix(a.rgb, b.rgb, blend).div(alpha.max(0.001));
  const pigment = tint ? rgb.mul(tint) : rgb;
  material.colorNode = vec4(pigment, alpha);
  material.normalNode = transformNormalToView(vec3(0, 1, 0));
  material.maskNode = biomeCoverage(lodStart, lodEnd, farStart, farEnd).far;
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.excludeFromReflection = true;
  mesh.userData.occlusionCull = false;
  return mesh;
}

export function configureBiomeAtlas(texture) {
  if (!texture) return texture;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
