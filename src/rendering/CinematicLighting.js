import * as THREE from 'three/webgpu';
import { fog, uniform, positionWorld, positionView, cameraPosition, mix, dot, smoothstep, float } from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { isMobileStartup } from '../config/mobileStartup.js';
import { prepareAtmosphereMaterials } from './atmosphereMaterials.js';
import { coastXNode } from '../world/coast.js';
import { createValleyFogNodes, resolveValleyFogConfig } from './valleyFog.js';

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
    this.shadowRenderEnabled = true;
    this.defaultSunCastShadow = Boolean(world.sun?.castShadow);
    this.fogColor = uniform(world.scene.fog.color.clone());
    this.fogDensity = uniform(world.scene.fog.density);
    // How far into snow country the view is; drives the valley mist.
    this.snowWeight = uniform(0);
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
    const viewDirection = positionWorld.sub(cameraPosition).normalize();
    // Broad sun-colored inscatter toward the light, damped in dense (rainy)
    // fog so grey weather stays grey; the horizon picks up sky tint early.
    const towardSun = dot(viewDirection, foliageLight.direction).max(0).pow(3.5);
    const clearWeather = float(1).sub(this.fogDensity.smoothstep(0.001, 0.004));
    const mistColor = mix(this.fogColor, foliageLight.color.mul(1.1), towardSun.mul(0.3).mul(clearWeather));
    const farColor = world.sky?.getColorNode(viewDirection) ?? mistColor;
    const hazeColor = mix(mistColor, farColor, smoothstep(350, 1000, distance));
    const valley = createValleyFogNodes({
      settings: resolveValleyFogConfig(config),
      terrainSampler: world.terrainSampler,
      weight: this.snowWeight,
      fogColor: this.fogColor,
      sunDirection: foliageLight.direction,
      sunColor: foliageLight.color.mul(foliageLight.strength),
    });
    if (valley) {
      // Two absorbers in series; the colour leans toward whichever did more.
      const combined = factor.oneMinus().mul(valley.factor.oneMinus()).oneMinus();
      const share = valley.factor.div(factor.add(valley.factor).max(1e-4));
      world.scene.fogNode = fog(mix(hazeColor, valley.color, share), combined);
    } else {
      world.scene.fogNode = fog(hazeColor, factor);
    }
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
    // Apply the cinematic budget to single-map shadows too. Previously the
    // default one-cascade path silently kept scene.yaml's 4096 map.
    world.sun.shadow.mapSize.setScalar(Math.min(world.sun.shadow.mapSize.x, settings.shadows.mapSize));
    if (settings.shadows.cascades > 1 && !isMobileStartup(config)
      && (globalThis.window?.innerWidth ?? Infinity) >= 768) {
      this.csm = new CSMShadowNode(world.sun, {
        cascades: settings.shadows.cascades,
        maxFar: settings.shadows.distance,
        lightMargin: 100,
        mode: 'practical',
      });
      this.csm.fade = true;
    } else {
      // A compact nearby shadow region keeps the mobile path affordable; desktop
      // widens it so the shadow edge sits past where the eye picks it up.
      const mobile = isMobileStartup(config) || (globalThis.window?.innerWidth ?? Infinity) < 768;
      const extent = mobile ? 55 : (settings.shadows.extent ?? 55);
      Object.assign(world.sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent });
      world.sun.shadow.camera.updateProjectionMatrix();
    }
  }

  // `exposureScale` is the regional exposure (snow country sits lower);
  // `snowWeight` how far into snow country the view is.
  update(exposureScale = 1, snowWeight = 0) {
    this.snowWeight.value = snowWeight;
    const { sun, scene } = this.world;
    if (this.config.cinematic?.enabled) {
      this.world.renderer.toneMappingExposure = this.config.cinematic.exposure * exposureScale;
    }
    this.fogColor.value.copy(scene.fog.color);
    this.fogDensity.value = scene.fog.density;
    foliageLight.direction.value.copy(sun.position).sub(sun.target.position).normalize();
    foliageLight.color.value.copy(sun.color);
    foliageLight.strength.value = Math.min(sun.intensity * 0.12, 0.8);
    foliageLight.fill.value = Math.min((this.world.hemisphere?.intensity ?? 0) * 0.35
      + (this.world.ambient?.intensity ?? 0) * 0.5, 0.7);
  }

  // Pauses the shadow maps (underwater, where they cannot be seen) by freezing
  // their updates, which skips the shadow pass. Toggling castShadow instead
  // disposed the light's shadow node while materials built with it kept it,
  // and when shadows came back those render objects were not rebuilt: the next
  // frame read the disposed map and the render loop failed on every frame
  // after surfacing from deep water.
  setShadowRenderEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.shadowRenderEnabled === next) return;
    this.shadowRenderEnabled = next;
    for (const light of [this.world.sun, ...(this.csm?.lights ?? [])]) {
      if (!light?.shadow) continue;
      light.shadow.autoUpdate = next;
      if (next) light.shadow.needsUpdate = true;
    }
  }

  activateShadows() {
    this.defaultSunCastShadow = Boolean(this.world.sun?.castShadow);
    if (this.world.sun) this.world.sun.castShadow = this.defaultSunCastShadow;
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
  const transmission = dot(view.negate(), foliageLight.direction).max(0).pow(2.2);
  return colorNode.mul(foliageLight.color).mul(transmission).mul(foliageLight.strength).mul(amount);
}
