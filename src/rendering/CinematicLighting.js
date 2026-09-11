import * as THREE from 'three/webgpu';
import { fog, uniform, positionWorld, positionView, cameraPosition, mix, dot, smoothstep, float } from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { prepareAtmosphereMaterials } from './atmosphereMaterials.js';
import { coastXNode } from '../world/coast.js';

// Shared by leaves, grass and atmosphere; updated from the active weather preset.
export const foliageLight = {
  direction: uniform(new THREE.Vector3(0, 1, 0)),
  color: uniform(new THREE.Color('#ffe0ae')),
  strength: uniform(0.3),
  fill: uniform(0.3),
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
    // The low sea elevation otherwise doubles meadow mist even on clear days.
    // Keep a hazy horizon, but let nearby sunny sand and water retain contrast.
    const sea = config.water.sea;
    const coastal = sea?.enabled ? cameraPosition.x.sub(coastXNode(cameraPosition.z, sea.shoreX)).smoothstep(-200, 0) : float(0);
    const coastalHaze = mix(0.5, 1, this.fogDensity.smoothstep(0.0015, 0.003));
    const density = this.fogDensity.add(lowMist.mul(atmosphere.density)).mul(mix(1, coastalHaze, coastal));
    const factor = distance.mul(density).pow(2).negate().exp().oneMinus().clamp(0, 1);
    const towardSun = dot(positionWorld.sub(cameraPosition).normalize(), foliageLight.direction).max(0).pow(8);
    const mistColor = mix(this.fogColor, foliageLight.color, towardSun.mul(0.16));
    const farColor = world.sky?.getColorNode(positionWorld.sub(cameraPosition).normalize()) ?? mistColor;
    world.scene.fogNode = fog(mix(mistColor, farColor, smoothstep(350, 1000, distance)), factor);
    const backdrop = world.terrain?.getObjectByName('Landscape046');
    if (backdrop?.isMesh && backdrop !== world.terrainTarget) {
      this.backdrop = backdrop;
      this.backdropOriginal = backdrop.material;
      const originals = Array.isArray(backdrop.material) ? backdrop.material : [backdrop.material];
      this.backdropMaterials = originals.map(original => {
        const material = world.renderer.library.fromMaterial(original.clone());
        material.transparent = true;
        material.depthWrite = false;
        // An opaque, fully fogged hill still cuts a polygon out of the cloud
        // layer. Fade only the non-walkable background mesh in dense fog.
        material.opacityNode = float(original.opacity).mul(float(1).sub(smoothstep(0.85, 1, factor)));
        return material;
      });
      backdrop.material = Array.isArray(backdrop.material) ? this.backdropMaterials : this.backdropMaterials[0];
    }
    world.renderer.toneMappingExposure = settings.exposure;
    world.sun.shadow.intensity = settings.shadows.intensity ?? 1;
    world.sun.shadow.radius = settings.shadows.radius ?? 1;
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
    foliageLight.fill.value = Math.min((this.world.hemisphere?.intensity ?? 0) * 0.35
      + (this.world.ambient?.intensity ?? 0) * 0.5, 0.7);
  }

  activateShadows() {
    // Run after cloning so tree LOD materials retain their maps and identities.
    if (this.config.cinematic?.enabled) this.restoreAtmosphereMaterials ??= prepareAtmosphereMaterials(this.world.scene);
    // Bind only after the initial water cube capture, so CSM initializes with
    // the gameplay camera rather than one of the six reflection cameras.
    if (this.csm) this.world.sun.shadow.shadowNode = this.csm;
  }

  resize() {
    if (this.csm?.camera) this.csm.updateFrustums();
  }

  dispose() {
    this.restoreAtmosphereMaterials?.();
    if (this.backdrop) this.backdrop.material = this.backdropOriginal;
    for (const material of this.backdropMaterials ?? []) material.dispose();
    this.csm?.dispose();
    this.world.scene.fogNode = null;
  }
}

export function foliageBacklight(colorNode, amount = 0.3) {
  const view = cameraPosition.sub(positionWorld).normalize();
  const transmission = dot(view.negate(), foliageLight.direction).max(0).pow(3);
  return colorNode.mul(foliageLight.color).mul(transmission).mul(foliageLight.strength).mul(amount);
}
