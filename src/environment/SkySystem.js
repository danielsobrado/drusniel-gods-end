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

    const preset = config.presets[config.ui.initialPreset].sky;
    const skyConfig = config.sky ?? {};

    this.uniforms = {
      ground: uniform(new THREE.Color(preset.groundColor)),
      horizon: uniform(new THREE.Color(preset.horizonColor)),
      zenith: uniform(new THREE.Color(preset.zenithColor)),
      halo: uniform(new THREE.Color(preset.sunHaloColor)),
      disk: uniform(new THREE.Color(preset.sunDiskColor)),
      horizonStart: uniform(skyConfig.horizonStart),
      horizonEnd: uniform(skyConfig.horizonEnd),
      haloPower: uniform(preset.haloPower),
      diskPower: uniform(preset.diskPower),
      sunDirection: uniform(new THREE.Vector3().fromArray(preset.sunPosition)),
    };

    const direction = normalize(positionWorldDirection);
    const up = vec3(0, 1, 0);
    const horizonBlend = smoothstep(
      this.uniforms.horizonStart,
      this.uniforms.horizonEnd,
      dot(direction, up),
    );
    let skyColor = mix(this.uniforms.ground, this.uniforms.horizon, horizonBlend);
    skyColor = mix(skyColor, this.uniforms.zenith, pow(horizonBlend, float(1.5)));

    const sunDot = max(
      dot(direction, normalize(this.uniforms.sunDirection)),
      float(0),
    );
    skyColor = mix(skyColor, this.uniforms.halo, pow(sunDot, this.uniforms.haloPower));
    skyColor = mix(skyColor, this.uniforms.disk, pow(sunDot, this.uniforms.diskPower));

    const material = new THREE.MeshBasicNodeMaterial();
    material.side = THREE.BackSide;
    material.depthWrite = false;
    material.depthTest = false;
    material.fog = false;
    material.toneMapped = true;
    material.colorNode = vec4(skyColor, 1);

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
      this.mesh.position.copy(camera.position);
    };
    this.mesh.userData.setPreset = (value) => this.setPreset(value);
    scene.add(this.mesh);
  }

  setPreset(sky) {
    if (sky.groundColor) this.uniforms.ground.value.set(sky.groundColor);
    if (sky.horizonColor) this.uniforms.horizon.value.set(sky.horizonColor);
    if (sky.zenithColor) this.uniforms.zenith.value.set(sky.zenithColor);
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
