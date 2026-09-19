import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

// The hemisphere's sky side weighs more than its ground side on spray and
// foam. SKY_GAIN stands in for the environment map lighting the rest of the
// scene, which these unlit materials do not sample.
const HEMISPHERE_SKY_SHARE = 0.65;
export const SKY_GAIN = 1.4;

/**
 * Light for the unlit water effects (foam, spray): the radiance a white
 * diffuse surface takes from the sun, facing it, and from the sky. Filled from
 * the environment's current light set each frame, so it dims with the night.
 */
export function createSceneLight() {
  const scratch = new THREE.Color();
  const light = {
    direction: uniform(new THREE.Vector3(0, 1, 0)),
    sun: uniform(new THREE.Color(0.8, 0.8, 0.8)),
    sky: uniform(new THREE.Color(0.15, 0.17, 0.2)),
    // `lighting` is EnvironmentController's current light set.
    update(lighting) {
      light.direction.value.copy(lighting.position).normalize();
      light.sun.value.copy(lighting.color).multiplyScalar(lighting.directionalIntensity / Math.PI);
      light.sky.value.copy(lighting.hemisphereSkyColor)
        .lerp(lighting.hemisphereGroundColor, 1 - HEMISPHERE_SKY_SHARE)
        .multiplyScalar(lighting.hemisphereIntensity)
        .add(scratch.copy(lighting.ambientColor).multiplyScalar(lighting.ambientIntensity))
        .multiplyScalar(1 / Math.PI);
    },
  };
  return light;
}
