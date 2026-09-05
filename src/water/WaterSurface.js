import * as THREE from 'three/webgpu';
import CubeRenderTarget from 'three/src/renderers/common/CubeRenderTarget.js';
import {
  Fn,
  abs,
  cameraPosition,
  cubeTexture,
  dot,
  float,
  floor,
  fract,
  length,
  max,
  mix,
  normalize,
  normalWorld,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  texture,
  time,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';

const TWO_PI = 6.283185;
const DEFAULT_WATER = Object.freeze({
  size: 400,
  segments: 128,
  position: [312.7059326171875, -17, 163.0625],
  speed: 4,
  waveHeight: 0.35,
  swellHeight: 1,
  swellLength: 26.7,
  mediumHeight: 0.5,
  mediumLength: 8.3,
  smallHeight: 0.3,
  smallLength: 4.6,
  detailHeight: 0.085,
  detailLength: 2.42,
  microHeight: 0.05,
  microLength: 2,
  distortion: 1.45,
  reflectionStrength: 0.9,
  sunColor: 0xffffff,
  sunDirection: [0.707, 0.8, 0.25],
  sunStrength: 0,
  deepColor: 0x07344a,
  surfaceColor: 0x033138,
  reflectionColor: 0x1c9199,
  roughness: 0,
  metalness: 0.48,
  fresnelPower: 1,
  fresnelStrength: 1,
  reflectionResolution: 1024,
  reflectionNear: 0.1,
  reflectionFar: 1000,
  rainRipples: true,
  rainRippleStrength: 3,
  rainRippleSize: 0.32,
  rainRippleSpeed: 2.25,
  rainRippleThickness: 0.08,
  rainRippleFade: 0.55,
  rainRippleDensity: 0.95,
  rainRippleRandomness: 0.82,
});

const WAVE_DIRECTIONS = Object.freeze([
  [1, 0.18],
  [-0.35, 1],
  [0.72, 0.65],
  [-0.82, 0.28],
  [0.35, -0.94],
  [-0.62, -0.74],
  [0.95, -0.28],
  [-0.18, 0.98],
]);

const NORMAL_EPSILON = 0.08;
const RIPPLE_HASH_SCALE = 43758.5453;
const RIPPLE_MIN_DISTANCE = 0.001;
const RAIN_THRESHOLD = 0.001;
const SHORE_MIN_DEPTH = -3;
const SHORE_MAX_DEPTH = 0;
const SHORE_OPACITY = 1;
const DEEP_OPACITY = 0.65;
const EMISSIVE_COLOR = new THREE.Color(0.003, 0.015, 0.018);

function mergeWaterConfig(config) {
  return {
    ...DEFAULT_WATER,
    ...(config.water ?? {}),
  };
}

export function createReflectionRenderTarget(params) {
  return new CubeRenderTarget(params.reflectionResolution, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
  });
}

function captureReflection(scene, renderer, mesh, params) {
  const renderTarget = createReflectionRenderTarget(params);
  const cubeCamera = new THREE.CubeCamera(
    params.reflectionNear,
    params.reflectionFar,
    renderTarget,
  );

  scene.add(cubeCamera);
  const previousVisibility = mesh.visible;
  mesh.visible = false;
  cubeCamera.position.copy(mesh.getWorldPosition(new THREE.Vector3()));
  cubeCamera.update(renderer, scene);
  mesh.visible = previousVisibility;
  scene.remove(cubeCamera);

  renderTarget.texture.mapping = THREE.CubeReflectionMapping;
  renderTarget.texture.colorSpace = THREE.SRGBColorSpace;
  return { texture: renderTarget.texture, renderTarget, cubeCamera };
}

function createWaterMaterial(mesh, params, terrainSampler, reflectionTexture) {
  const terrain = terrainSampler.getShaderData();
  const uniforms = {
    speed: uniform(params.speed),
    waveHeight: uniform(params.waveHeight),
    swellHeight: uniform(params.swellHeight),
    swellLength: uniform(params.swellLength),
    mediumHeight: uniform(params.mediumHeight),
    mediumLength: uniform(params.mediumLength),
    smallHeight: uniform(params.smallHeight),
    smallLength: uniform(params.smallLength),
    detailHeight: uniform(params.detailHeight),
    detailLength: uniform(params.detailLength),
    microHeight: uniform(params.microHeight),
    microLength: uniform(params.microLength),
    distortion: uniform(params.distortion),
    reflectionStrength: uniform(params.reflectionStrength),
    sunColor: uniform(new THREE.Color(params.sunColor)),
    sunDirection: uniform(new THREE.Vector3().fromArray(params.sunDirection).normalize()),
    sunStrength: uniform(params.sunStrength),
    deepColor: uniform(new THREE.Color(params.deepColor)),
    surfaceColor: uniform(new THREE.Color(params.surfaceColor)),
    reflectionColor: uniform(new THREE.Color(params.reflectionColor)),
    roughness: uniform(params.roughness),
    metalness: uniform(params.metalness),
    fresnelPower: uniform(params.fresnelPower),
    fresnelStrength: uniform(params.fresnelStrength),
  };

  if (params.rainRipples) {
    uniforms.rainRippleStrength = uniform(params.rainRippleStrength);
    uniforms.rainRippleSize = uniform(params.rainRippleSize);
    uniforms.rainRippleSpeed = uniform(params.rainRippleSpeed);
    uniforms.rainRippleThickness = uniform(params.rainRippleThickness);
    uniforms.rainRippleFade = uniform(params.rainRippleFade);
    uniforms.rainRippleDensity = uniform(params.rainRippleDensity);
    uniforms.rainRippleRandomness = uniform(params.rainRippleRandomness);
  }

  const wave = Fn(([point, direction, wavelength, amplitude, phase, scaledTime]) => {
    const frequency = float(TWO_PI).div(wavelength);
    const wavePhase = point.x.mul(direction.x)
      .add(point.y.mul(direction.y))
      .mul(frequency)
      .add(scaledTime.mul(phase));
    const value = sin(wavePhase);
    return value.mul(0.75)
      .add(value.mul(value).mul(value).mul(0.25))
      .mul(amplitude);
  });

  const waves = Fn(([point, scaledTime]) => {
    const d1 = vec2(...WAVE_DIRECTIONS[0]);
    const d2 = vec2(...WAVE_DIRECTIONS[1]);
    const d3 = vec2(...WAVE_DIRECTIONS[2]);
    const d4 = vec2(...WAVE_DIRECTIONS[3]);
    const d5 = vec2(...WAVE_DIRECTIONS[4]);
    const d6 = vec2(...WAVE_DIRECTIONS[5]);
    const d7 = vec2(...WAVE_DIRECTIONS[6]);
    const d8 = vec2(...WAVE_DIRECTIONS[7]);

    return wave(point, d1, uniforms.swellLength, uniforms.swellHeight, float(0.42), scaledTime)
      .add(wave(point, d2, uniforms.swellLength.mul(1.35), uniforms.swellHeight.mul(0.55), float(0.31), scaledTime))
      .add(wave(point, d3, uniforms.mediumLength, uniforms.mediumHeight, float(0.64), scaledTime))
      .add(wave(point, d4, uniforms.mediumLength.mul(0.82), uniforms.mediumHeight.mul(0.52), float(0.52), scaledTime))
      .add(wave(point, d5, uniforms.smallLength, uniforms.smallHeight.mul(0.65), float(0.91), scaledTime))
      .add(wave(point, d6, uniforms.smallLength.mul(0.72), uniforms.smallHeight.mul(0.42), float(0.77), scaledTime))
      .add(wave(point, d7, uniforms.detailLength, uniforms.detailHeight, float(0.45), scaledTime))
      .add(wave(point, d8, uniforms.detailLength.mul(0.72), uniforms.detailHeight.mul(0.55), float(0.22), scaledTime))
      .add(wave(point, d1, uniforms.microLength, uniforms.microHeight, float(0.15), scaledTime))
      .add(wave(point, d4, uniforms.microLength.mul(1.35), uniforms.microHeight.mul(0.45), float(0.82), scaledTime))
      .mul(uniforms.waveHeight);
  });

  const baseNormal = Fn(([point, scaledTime]) => {
    const epsilon = float(NORMAL_EPSILON);
    const center = waves(point, scaledTime);
    const offsetX = waves(point.add(vec2(epsilon, 0)), scaledTime);
    const offsetY = waves(point.add(vec2(0, epsilon)), scaledTime);
    const dx = offsetX.sub(center).div(epsilon);
    const dy = offsetY.sub(center).div(epsilon);
    return normalize(vec3(dx.negate(), dy.negate(), 1));
  });

  const rainNormal = Fn(() => {
    const point = positionLocal.xy.mul(uniforms.rainRippleDensity);
    const cell = floor(point);
    const local = fract(point).sub(0.5);
    const randomA = fract(
      sin(dot(cell, vec2(127.1, 311.7))).mul(RIPPLE_HASH_SCALE),
    );
    const randomB = fract(
      sin(dot(cell, vec2(269.5, 183.3))).mul(RIPPLE_HASH_SCALE),
    );
    const offset = vec2(randomA.sub(0.5), randomB.sub(0.5))
      .mul(uniforms.rainRippleRandomness);
    const delta = local.sub(offset);
    const distance = length(delta);
    const phase = fract(time.mul(uniforms.rainRippleSpeed).add(randomA));
    const radius = phase.mul(uniforms.rainRippleSize);
    const ring = float(1).sub(
      smoothstep(float(0), uniforms.rainRippleThickness, abs(distance.sub(radius))),
    );
    const fade = float(1).sub(phase).pow(uniforms.rainRippleFade);
    const strength = ring.mul(fade).mul(uniforms.rainRippleStrength);
    const direction = delta.div(max(distance, float(RIPPLE_MIN_DISTANCE)));
    return normalize(vec3(
      direction.x.negate().mul(strength),
      direction.y.negate().mul(strength),
      1,
    ));
  });

  const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  material.positionNode = Fn(() => {
    const height = waves(positionLocal.xy, time.mul(uniforms.speed));
    return positionLocal.add(vec3(0, 0, height));
  })();

  let rainy = false;
  const rebuildNormal = () => {
    material.normalNode = Fn(() => {
      const normal = baseNormal(positionLocal.xy, time.mul(uniforms.speed));
      if (!rainy || !params.rainRipples) return transformNormalToView(normal);
      const ripple = rainNormal();
      return transformNormalToView(
        normalize(normal.add(ripple.sub(vec3(0, 0, 1)))),
      );
    })();
    material.needsUpdate = true;
  };
  rebuildNormal();

  const reflectionNode = reflectionTexture ? cubeTexture(reflectionTexture) : null;
  material.colorNode = Fn(() => {
    const normal = normalize(normalWorld);
    const viewDirection = normalize(cameraPosition.sub(positionWorld));
    const facing = max(dot(normal, viewDirection), float(0));
    const fresnel = pow(float(1).sub(facing), uniforms.fresnelPower);
    const baseColor = mix(
      uniforms.deepColor,
      uniforms.surfaceColor,
      fresnel.mul(uniforms.fresnelStrength),
    );

    let reflectedColor = uniforms.reflectionColor;
    if (reflectionNode) {
      const reflectionDirection = normalize(reflect(viewDirection.negate(), normal));
      reflectedColor = reflectionNode.sample(reflectionDirection).rgb;
    }

    const reflection = reflectedColor.mul(uniforms.reflectionStrength);
    const reflectedSunDirection = normalize(reflect(uniforms.sunDirection.negate(), normal));
    const sunFacing = max(dot(viewDirection, reflectedSunDirection), float(0));
    const sunHighlight = pow(sunFacing, float(90))
      .mul(uniforms.sunColor)
      .mul(uniforms.sunStrength);
    const sunGlint = pow(sunFacing, float(12))
      .mul(uniforms.sunColor)
      .mul(uniforms.sunStrength)
      .mul(0.15);
    const sunDiffuse = max(dot(uniforms.sunDirection, normal), float(0))
      .mul(uniforms.sunColor)
      .mul(0.12);
    const reflected = reflection.add(sunHighlight).add(sunGlint);
    return mix(
      baseColor.add(sunDiffuse),
      reflected,
      fresnel.mul(uniforms.reflectionStrength),
    );
  })();

  const terrainMin = vec2(terrain.boundsMin.x, terrain.boundsMin.z);
  const terrainSize = vec2(terrain.boundsSize.x, terrain.boundsSize.z);
  material.opacityNode = Fn(() => {
    const terrainUv = positionWorld.xz.sub(terrainMin).div(terrainSize);
    const terrainSample = texture(terrain.texture, terrainUv).r;
    const terrainHeight = mix(float(terrain.minHeight), float(terrain.maxHeight), terrainSample);
    const depth = terrainHeight.sub(float(params.position[1]));
    const shoreBlend = smoothstep(float(SHORE_MIN_DEPTH), float(SHORE_MAX_DEPTH), depth);
    return mix(float(SHORE_OPACITY), float(DEEP_OPACITY), shoreBlend);
  })();

  material.roughnessNode = uniforms.roughness;
  material.metalnessNode = uniforms.metalness;
  material.emissiveNode = Fn(() => {
    const normal = normalize(normalWorld);
    const viewDirection = normalize(cameraPosition.sub(positionWorld));
    const facing = max(dot(normal, viewDirection), float(0));
    const fresnel = pow(float(1).sub(facing), float(4));
    return vec3(EMISSIVE_COLOR.r, EMISSIVE_COLOR.g, EMISSIVE_COLOR.b).mul(fresnel);
  })();

  material.side = THREE.FrontSide;
  material.transparent = true;
  material.depthWrite = false;
  material.name = 'LakeWater';
  mesh.material = material;
  mesh.renderOrder = 1;

  return {
    material,
    uniforms,
    setRain(enabled) {
      const next = Boolean(enabled);
      if (next === rainy) return;
      rainy = next;
      rebuildNormal();
    },
  };
}

export class WaterSurface {
  constructor(scene, renderer, terrainRoot, terrainSampler, config) {
    this.scene = scene;
    this.params = mergeWaterConfig(config);
    this.geometry = new THREE.PlaneGeometry(
      this.params.size,
      this.params.size,
      this.params.segments,
      this.params.segments,
    );
    this.mesh = new THREE.Mesh(this.geometry);
    this.mesh.rotation.set(-Math.PI * 0.5, 0, 0);
    this.mesh.position.fromArray(this.params.position);

    this.reflection = captureReflection(scene, renderer, this.mesh, this.params);
    this.shader = createWaterMaterial(
      this.mesh,
      this.params,
      terrainSampler,
      this.reflection.texture,
    );
    this.material = this.shader.material;
    this.uniforms = this.shader.uniforms;
    scene.add(this.mesh);

    const collider = terrainRoot?.getObjectByName(config.water?.colliderName ?? 'WaterCollider');
    this.bounds = collider
      ? new THREE.Box3().setFromObject(collider)
      : new THREE.Box3().setFromObject(this.mesh);
  }

  setRain(enabled) {
    this.shader.setRain(enabled);
  }

  setRainIntensity(value) {
    const intensity = THREE.MathUtils.clamp(Number(value), 0, 1);
    this.setRain(intensity > RAIN_THRESHOLD);
    if (this.uniforms.rainRippleThickness) {
      this.uniforms.rainRippleThickness.value = THREE.MathUtils.lerp(
        0,
        this.params.rainRippleThickness,
        intensity,
      );
    }
  }

  containsPoint(position) {
    return position.x >= this.bounds.min.x
      && position.x <= this.bounds.max.x
      && position.z >= this.bounds.min.z
      && position.z <= this.bounds.max.z
      && position.y <= this.bounds.max.y + 1.5;
  }

  dispose() {
    this.scene?.remove(this.mesh);
    this.material?.dispose?.();
    this.geometry?.dispose?.();
    this.reflection?.renderTarget?.dispose?.();
  }
}
