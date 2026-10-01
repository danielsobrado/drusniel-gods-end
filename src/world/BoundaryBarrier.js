import { Mesh } from 'three/webgpu';
import { createBoundaryGeometry } from './boundaryGeometry.js';
import { createBarrierNoise, createBoundaryMaterial, resolveBarrierSettings } from './BoundaryBarrierMaterial.js';
import { logger } from '../utils/logger.js';

export class BoundaryBarrier {
  constructor({ scene, terrainRoot, terrainSampler, config }) {
    Object.assign(this, { scene, terrainRoot, terrainSampler, config });
    this.mesh = null;
    this.material = null;
    this.noise = null;
    this.uniforms = null;
    this.fences = [];
    this.disposed = false;
  }

  init() {
    if (this.disposed || this.mesh || !this.config.boundaryBarrier?.enabled) return this;
    let geometry;
    try {
      const settings = resolveBarrierSettings(this.config.boundaryBarrier);
      if (!this.terrainRoot) throw new Error('Authored terrain is unavailable.');
      geometry = createBoundaryGeometry(this.config.collisions?.worldBounds, this.terrainSampler, settings);
      this.noise = createBarrierNoise();
      const shader = createBoundaryMaterial(settings, geometry, this.noise);
      this.material = shader.material;
      this.uniforms = shader.uniforms;
      this.mesh = new Mesh(geometry, this.material);
      this.mesh.name = 'BoundaryForceField';
      // Compose the field before transparent water so a submerged boundary is
      // absorbed by deep water instead of being added on top of the sea.
      this.mesh.renderOrder = 0;
      this.mesh.userData.occlusionOccluder = false;
      this.mesh.userData.occlusionCull = false;
      this.mesh.userData.excludeFromReflection = true;
      this.scene.add(this.mesh);
      this.terrainRoot.traverse(object => {
        if (object.name === 'TerrainPart:structures/fence' || object.name === 'fence6_Material_0042'
          || object.name === 'fence6_Material_0.042') {
          this.fences.push({ object, visible: object.visible });
          object.visible = false;
        }
      });
      this.update(0);
    } catch (error) {
      this.mesh?.removeFromParent();
      geometry?.dispose();
      this.material?.dispose();
      this.noise?.dispose();
      this.mesh = this.material = this.noise = this.uniforms = null;
      for (const { object, visible } of this.fences) object.visible = visible;
      this.fences.length = 0;
      logger.warn('Force field unavailable; retaining the authored fence.', error);
    }
    return this;
  }

  setEnabled(enabled) {
    if (this.disposed) return;
    if (enabled && !this.mesh) {
      this.config.boundaryBarrier = { ...this.config.boundaryBarrier, enabled: true };
      this.init();
    }
    if (!this.mesh) return;
    this.config.boundaryBarrier.enabled = Boolean(enabled);
    this.mesh.visible = Boolean(enabled);
    for (const { object, visible } of this.fences) object.visible = enabled ? false : visible;
  }

  update(delta, playerPosition) {
    if (!this.uniforms) return;
    if (Number.isFinite(delta) && delta > 0) this.uniforms.clock.value += delta;
    if (playerPosition) this.uniforms.playerPosition.value.copy(playerPosition);
    this.uniforms.fogDensity.value = Math.max(0, this.scene.fog?.density ?? 0);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh?.removeFromParent();
    this.mesh?.geometry.dispose();
    this.material?.dispose();
    this.noise?.dispose();
    for (const { object, visible } of this.fences) object.visible = visible;
    this.fences.length = 0;
    this.mesh = this.material = this.noise = this.uniforms = null;
  }
}
