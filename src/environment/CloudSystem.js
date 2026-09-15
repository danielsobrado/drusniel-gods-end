import * as THREE from 'three/webgpu';
import { updateCloudShadow } from '../rendering/cloudShadow.js';
import {
  Fn,
  cameraPosition,
  dot,
  float,
  floor,
  fract,
  mix,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

const HASH_VECTOR = Object.freeze([127.1, 311.7]);
const HASH_SCALE = 43758.5453;
const OCTAVES = Object.freeze([
  [1, 0.5],
  [2, 0.25],
  [4, 0.125],
  [8, 0.0625],
  [16, 0.03125],
]);
const CLOUD_COLOR_DARK = Object.freeze([0.65, 0.68, 0.72]);
const CLOUD_COLOR_LIGHT = Object.freeze([1, 1, 1]);

export class CloudSystem {
  constructor(scene, config) {
    this.scene = scene;
    this.config = config.clouds;
    this.cinematic = Boolean(config.cinematic?.enabled);
    this.stylized = this.cinematic && Boolean(config.cinematic?.style?.enabled);

    const wind = this.config.wind;
    this.followCamera = this.cinematic || Boolean(this.config.followCamera);
    this.camera = null;

    this.uniforms = {
      time: uniform(0),
      coverage: uniform(this.config.coverage),
      softness: uniform(this.config.softness),
      density: uniform(this.config.density),
      speed: uniform(this.config.speed),
      wind: uniform(new THREE.Vector2().fromArray(wind)),
      opacity: uniform(this.config.opacity),
    };

    this.geometry = new THREE.PlaneGeometry(this.config.size, this.config.size, 1, 1);
    this.material = this.#createMaterial();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.renderOrder = -100;
    this.mesh.rotation.x = -Math.PI * 0.5;
    this.mesh.position.y = this.config.height;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  #createMaterial() {
    const hash2 = Fn(([point]) => (
      fract(sin(dot(point, vec2(...HASH_VECTOR))).mul(HASH_SCALE))
    ));

    const noise2 = Fn(([point]) => {
      const cell = floor(point);
      const local = fract(point);
      const fade = local.mul(local).mul(vec2(3).sub(local.mul(2)));

      const a = hash2(cell);
      const b = hash2(cell.add(vec2(1, 0)));
      const c = hash2(cell.add(vec2(0, 1)));
      const d = hash2(cell.add(vec2(1, 1)));
      const x0 = mix(a, b, fade.x);
      const x1 = mix(c, d, fade.x);
      return mix(x0, x1, fade.y);
    });

    const fbm = Fn(([point]) => {
      let value = float(0);
      for (const [scale, weight] of OCTAVES) {
        value = value.add(noise2(point.mul(scale)).mul(weight));
      }
      return value;
    });

    const cloud = Fn(() => {
      const world = vec2(positionWorld.x, positionWorld.z);
      const drift = this.uniforms.wind
        .mul(this.uniforms.time)
        .mul(this.uniforms.speed);

      const base = fbm(world.mul(this.stylized ? 0.0035 : 0.008).add(drift));
      const mid = fbm(world.mul(0.018).add(drift.mul(1.5)));
      const fine = fbm(world.mul(0.045).add(drift.mul(2)));
      const combined = this.stylized ? base.mul(0.82).add(mid.mul(0.16)).add(fine.mul(0.02))
        : base.mul(0.65).add(mid.mul(0.25)).add(fine.mul(0.1));
      const density = combined.mul(this.uniforms.density);

      const mask = smoothstep(
        this.uniforms.coverage.sub(this.uniforms.softness.mul(this.stylized ? 0.65 : 1)),
        this.uniforms.coverage.add(this.uniforms.softness.mul(this.stylized ? 0.65 : 1)),
        density,
      );
      const detail = smoothstep(float(0.25), float(0.75), fine);
      let alpha = mask.mul(mix(float(0.7), float(1), detail)).mul(this.uniforms.opacity);
      if (this.cinematic) {
        const edge = float(1).sub(smoothstep(0.28, 0.48, uv().sub(0.5).length()));
        const elevation = positionWorld.sub(cameraPosition).normalize().y.abs();
        alpha = alpha.mul(edge).mul(smoothstep(0.025, 0.12, elevation));
      }
      const colorBlend = smoothstep(float(0.25), float(0.8), combined);
      const color = mix(
        this.stylized ? vec3(0.65, 0.8, 0.88) : vec3(...CLOUD_COLOR_DARK),
        this.stylized ? vec3(1, 0.98, 0.9) : vec3(...CLOUD_COLOR_LIGHT),
        colorBlend,
      );
      return vec4(color, alpha);
    })();

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
      fog: true,
    });
    material.colorNode = cloud.rgb;
    material.opacityNode = cloud.a;
    return material;
  }

  update(deltaSeconds) {
    this.uniforms.time.value += deltaSeconds;
    updateCloudShadow({
      windX: this.uniforms.wind.value.x,
      windZ: this.uniforms.wind.value.y,
      time: this.uniforms.time.value,
      speed: this.uniforms.speed.value,
      coverage: this.uniforms.coverage.value,
      strength: this.config.shadowStrength ?? 0.4,
    });
    if (this.followCamera && this.camera) {
      this.mesh.position.x = this.camera.position.x;
      this.mesh.position.z = this.camera.position.z;
    }
  }

  setCoverage(value) {
    this.uniforms.coverage.value = value;
  }

  setSoftness(value) {
    this.uniforms.softness.value = value;
  }

  setDensity(value) {
    this.uniforms.density.value = value;
  }

  setSpeed(value) {
    this.uniforms.speed.value = value;
  }

  setOpacity(value) {
    this.uniforms.opacity.value = value;
  }

  setWind(x, y) {
    this.uniforms.wind.value.set(x, y);
  }

  dispose() {
    this.scene?.remove(this.mesh);
    this.geometry?.dispose?.();
    this.material?.dispose?.();
    this.scene = null;
  }
}
