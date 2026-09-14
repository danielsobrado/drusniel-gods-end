import * as THREE from 'three/webgpu';
import {
  dot,
  float,
  max,
  mix,
  normalize,
  positionWorldDirection,
  pow,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';

export class SkySystem {
  constructor(scene, config) {
    this.scene = scene;
    this.cinematic = Boolean(config.cinematic?.enabled);
    this.stylized = this.cinematic && Boolean(config.cinematic?.style?.enabled);

    const preset = config.presets[config.ui.initialPreset].sky;
    const skyConfig = config.sky ?? {};
    this.uniforms = {
      ground: uniform(new THREE.Color(preset.groundColor)),
      horizon: uniform(new THREE.Color(preset.horizonColor)),
      zenith: uniform(new THREE.Color(preset.zenithColor)),
      fog: uniform(new THREE.Color(preset.fogColor)),
      halo: uniform(new THREE.Color(preset.sunHaloColor)),
      disk: uniform(new THREE.Color(preset.sunDiskColor)),
      horizonStart: uniform(skyConfig.horizonStart),
      horizonEnd: uniform(skyConfig.horizonEnd),
      haloPower: uniform(preset.haloPower),
      diskPower: uniform(preset.diskPower),
      sunDirection: uniform(new THREE.Vector3().fromArray(preset.sunPosition)),
    };

    const material = new THREE.MeshBasicNodeMaterial();
    material.side = THREE.BackSide;
    material.depthWrite = false;
    material.depthTest = false;
    material.fog = false;
    material.toneMapped = true;
    material.colorNode = vec4(this.getColorNode(normalize(positionWorldDirection)), 1);

    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(
        skyConfig.radius,
        skyConfig.widthSegments,
        skyConfig.heightSegments,
      ),
      material,
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'Sky';
    this.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      camera.getWorldPosition(this.mesh.position);
      this.mesh.updateMatrixWorld(true);
    };
    this.mesh.userData.setPreset = (value) => this.setPreset(value);
    this.mesh.userData.getWaterColorNode = (direction) => this.getColorNode(direction, false);
    scene.add(this.mesh);
  }

  getColorNode(direction, includeSunDisk = true) {
    const up = vec3(0, 1, 0);
    const horizonBlend = smoothstep(
      this.uniforms.horizonStart,
      this.uniforms.horizonEnd,
      dot(direction, up),
    );
    let skyColor = mix(this.uniforms.ground, this.uniforms.horizon, horizonBlend);
    skyColor = mix(skyColor, this.uniforms.zenith, pow(horizonBlend, float(1.5)));
    if (this.cinematic) {
      const elevation = dot(direction, up);
      const highSky = smoothstep(0.02, this.stylized ? 0.4 : 0.7, elevation);
      const warmBand = smoothstep(0, 0.1, elevation)
        .mul(float(1).sub(smoothstep(0.1, 0.35, elevation))).mul(0.15);
      skyColor = mix(
        mix(this.uniforms.fog, this.uniforms.horizon, warmBand),
        this.uniforms.zenith,
        highSky,
      );
      // Compress the horizon toward the fog color so the sky meets the
      // aerial perspective of the far terrain instead of ending in a hard band.
      skyColor = mix(skyColor, this.uniforms.fog, float(1).sub(elevation.abs()).pow(6).mul(0.55));
    }

    const sunDot = max(dot(direction, normalize(this.uniforms.sunDirection)), float(0));
    skyColor = mix(skyColor, this.uniforms.halo, pow(sunDot, this.uniforms.haloPower));
    if (includeSunDisk) {
      skyColor = mix(skyColor, this.uniforms.disk, pow(sunDot, this.uniforms.diskPower));
    }
    return skyColor;
  }

  setPreset(sky) {
    if (sky.groundColor) this.uniforms.ground.value.set(sky.groundColor);
    if (sky.horizonColor) this.uniforms.horizon.value.set(sky.horizonColor);
    if (sky.zenithColor) this.uniforms.zenith.value.set(sky.zenithColor);
    if (sky.fogColor) this.uniforms.fog.value.set(sky.fogColor);
    if (sky.sunHaloColor) this.uniforms.halo.value.set(sky.sunHaloColor);
    if (sky.sunDiskColor) this.uniforms.disk.value.set(sky.sunDiskColor);
    if (sky.sunPosition) this.uniforms.sunDirection.value.fromArray(sky.sunPosition);
    if (sky.horizonStart !== undefined) this.uniforms.horizonStart.value = sky.horizonStart;
    if (sky.horizonEnd !== undefined) this.uniforms.horizonEnd.value = sky.horizonEnd;
    if (sky.haloPower !== undefined) this.uniforms.haloPower.value = sky.haloPower;
    if (sky.diskPower !== undefined) this.uniforms.diskPower.value = sky.diskPower;
  }

  dispose() {
    this.scene?.remove(this.mesh);
    this.mesh?.geometry?.dispose?.();
    this.mesh?.material?.dispose?.();
    this.scene = null;
  }
}
