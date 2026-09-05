import * as THREE from 'three/webgpu';
import { fog, uniform, positionWorld, positionView, cameraPosition, mix, dot } from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';

// Shared by leaves, grass and atmosphere; updated from the active weather preset.
export const foliageLight = {
  direction: uniform(new THREE.Vector3(0, 1, 0)),
  color: uniform(new THREE.Color('#ffe0ae')),
  strength: uniform(0.3),
};

export class CinematicLighting {
  constructor(world, config) {
    this.world = world;
    this.config = config;
    this.fogColor = uniform(world.scene.fog.color.clone());
    this.fogDensity = uniform(world.scene.fog.density);
    const settings = config.cinematic;
    if (!settings?.enabled) return;
    const atmosphere = settings.atmosphere;
    const distance = positionView.z.negate().max(0);
    const height = positionWorld.y.add(cameraPosition.y).mul(0.5);
    const lowMist = height.sub(atmosphere.height).mul(-atmosphere.falloff).exp().clamp(0.08, 2);
    const density = this.fogDensity.add(lowMist.mul(atmosphere.density));
    const factor = distance.mul(density).pow(2).negate().exp().oneMinus().clamp(0, 0.98);
    const towardSun = dot(positionWorld.sub(cameraPosition).normalize(), foliageLight.direction).max(0).pow(8);
    const mistColor = mix(this.fogColor, foliageLight.color, towardSun.mul(0.16));
    world.scene.fogNode = fog(mistColor, factor);
    world.renderer.toneMappingExposure = settings.exposure;
    if (settings.shadows.cascades > 1 && window.innerWidth >= 768 && world.renderer.backend.isWebGPUBackend) {
      world.sun.shadow.mapSize.setScalar(settings.shadows.mapSize);
      this.csm = new CSMShadowNode(world.sun, {
        cascades: settings.shadows.cascades,
        maxFar: settings.shadows.distance,
        lightMargin: 100,
        mode: 'practical',
      });
      this.csm.fade = true;
    } else {
      // A compact nearby shadow region keeps the WebGL/mobile path affordable.
      Object.assign(world.sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55 });
      world.sun.shadow.camera.updateProjectionMatrix();
    }
  }

  update() {
    const { sun, scene } = this.world;
    this.fogColor.value.copy(scene.fog.color);
    this.fogDensity.value = scene.fog.density;
    foliageLight.direction.value.copy(sun.position).sub(sun.target.position).normalize();
    foliageLight.color.value.copy(sun.color);
    foliageLight.strength.value = Math.min(sun.intensity * 0.12, 0.55);
  }

  activateShadows() {
    // Bind only after the initial water cube capture, so CSM initializes with
    // the gameplay camera rather than one of the six reflection cameras.
    if (this.csm) this.world.sun.shadow.shadowNode = this.csm;
  }

  resize() {
    if (this.csm?.camera) this.csm.updateFrustums();
  }

  dispose() {
    this.csm?.dispose();
    this.world.scene.fogNode = null;
  }
}

export function foliageBacklight(colorNode, amount = 0.3) {
  const view = cameraPosition.sub(positionWorld).normalize();
  const transmission = dot(view.negate(), foliageLight.direction).max(0).pow(3);
  return colorNode.mul(foliageLight.color).mul(transmission).mul(foliageLight.strength).mul(amount);
}
