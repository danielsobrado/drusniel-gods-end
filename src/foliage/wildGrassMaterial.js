import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  float,
  modelWorldMatrix,
  positionGeometry,
  positionLocal,
  sin,
  smoothstep,
  texture,
  time,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import { foliageBacklight } from '../rendering/CinematicLighting.js';
import {
  createCinematicWindFieldNode,
  getSharedWindUniforms,
} from '../weather/WindField.js';

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

  const origin = attribute('clumpOrigin', 'vec3');
  const distance = origin.xz.sub(cameraPosition.xz).length();
  const fade = smoothstep(radius.sub(fadeWidth), radius, distance).oneMinus();
  const sharedWind = getSharedWindUniforms();
  const world = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
  const field = createCinematicWindFieldNode({
    positionXZ: world.xz,
    timeNode: time,
    directionDegrees: sharedWind.directionDegrees,
    intensity: windIntensity,
    simulationSpeed: sharedWind.simulationSpeed,
    noiseScale: sharedWind.noiseScale,
    config,
  });
  const heightWeight = smoothstep(0, height.mul(0.85), positionGeometry.y.max(0));
  const phase = origin.x.mul(0.17).add(origin.z.mul(0.11));
  const flutter = sin(time.mul(sharedWind.simulationSpeed).mul(1.6).add(phase))
    .mul(windFlutter)
    .mul(heightWeight);
  const bend = field.strength.mul(windBend).mul(heightWeight);
  const offset = vec3(
    field.direction.x.mul(bend).add(flutter.mul(field.direction.y.negate())),
    0,
    field.direction.y.mul(bend).add(flutter.mul(field.direction.x)),
  );
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
