import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  float,
  modelWorldMatrix,
  positionGeometry,
  positionLocal,
  smoothstep,
  texture,
  uv,
  vec4,
} from 'three/tsl';
import { foliageBacklight } from '../rendering/CinematicLighting.js';
import { createFoliageWind } from './foliageWind.js';

export function createWildGrassMaterial({
  map,
  color,
  roughness,
  metalness,
  height,
  radius,
  fadeWidth,
  windIntensity,
  windBend,
  windFlutter,
  alphaTest,
  shadowAlphaTest,
  cinematic,
  config,
  coverage = null,
}) {
  const material = new THREE.MeshStandardNodeMaterial();
  material.map = map ?? null;
  if (color) material.color.copy(color);
  material.roughness = roughness ?? 0.82;
  material.metalness = metalness ?? 0;
  material.side = THREE.DoubleSide;
  material.transparent = false;
  material.depthWrite = true;
  material.alphaTestNode = float(alphaTest ?? 0.32);
  material.alphaToCoverage = Boolean(cinematic);
  material.maskNode = coverage;

  const origin = attribute('clumpOrigin', 'vec3');
  const distance = origin.xz.sub(cameraPosition.xz).length();
  const fade = smoothstep(radius.sub(fadeWidth), radius, distance).oneMinus();
  const world = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
  const heightWeight = smoothstep(0, height.mul(0.85), positionGeometry.y.max(0));
  const offset = createFoliageWind({ origin, world, distance, heightWeight,
    windIntensity, windBend, windFlutter, config });
  material.positionNode = positionLocal.sub(origin).add(offset).mul(fade).add(origin);

  if (map) {
    const sample = texture(map, uv());
    material.colorNode = vec4(sample.rgb, sample.a);
    if (cinematic) {
      material.emissiveNode = foliageBacklight(
        sample.rgb,
        config?.cinematic?.vegetation?.backlight ?? 0.32,
      );
    }
    material.maskShadowNode = Fn(() => texture(map, uv()).a.greaterThan(shadowAlphaTest ?? 0.55))();
  }
  return material;
}
