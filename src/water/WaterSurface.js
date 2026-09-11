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
  uniformArray,
  reflector,
} from 'three/tsl';
import { createCinematicWaterMaterial } from './WaterMaterial.js';
import { createWaterGeometry } from './waterGeometry.js';
import { RiverDetails } from './RiverDetails.js';
import { coastX } from '../world/coast.js';
import { ReflectionBudget } from './ReflectionBudget.js';

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

function captureReflection(_scene, _renderer, mesh, params) {
  const renderTarget = createReflectionRenderTarget(params);
  const cubeCamera = new THREE.CubeCamera(
    params.reflectionNear,
    params.reflectionFar,
    renderTarget,
  );

  cubeCamera.position.copy(mesh.getWorldPosition(new THREE.Vector3()));
  cubeCamera.position.y += 1;
  // Capture after the main camera's shader compilation. A reflection camera
  // must not become the camera used to initialize cascaded shadows.

  renderTarget.texture.mapping = THREE.CubeReflectionMapping;
  renderTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
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
    rippleClock: uniform(0),
    footsteps: uniformArray(Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, -100, 0))),
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
  const footNormal = Fn(() => {
    const offset = vec3(0).toVar();
    for (let i = 0; i < 6; i++) {
      const impact = uniforms.footsteps.element(i);
      const age = uniforms.rippleClock.sub(impact.z).max(0);
      const delta = positionWorld.xz.sub(impact.xy);
      const distance = delta.length().max(0.01);
      const ring = distance.sub(age.mul(2.8));
      const wave = sin(ring.mul(15)).mul(ring.pow(2).mul(-6).exp())
        .mul(age.mul(-1.3).exp()).mul(impact.w).mul(0.12);
      offset.addAssign(vec3(delta.x.div(distance).mul(wave), delta.y.div(distance).mul(wave).negate(), 0));
    }
    return offset;
  });
  const rebuildNormal = () => {
    material.normalNode = Fn(() => {
      const normal = normalize(baseNormal(positionLocal.xy, time.mul(uniforms.speed)).add(footNormal()));
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
  const terrainMin = vec2(terrain.boundsMin.x, terrain.boundsMin.z);
  const terrainSize = vec2(terrain.boundsSize.x, terrain.boundsSize.z);
  const terrainUv = positionWorld.xz.sub(terrainMin).div(terrainSize);
  const terrainHeight = mix(float(terrain.minHeight), float(terrain.maxHeight), texture(terrain.texture, terrainUv).r);
  const waterDepth = positionWorld.y.sub(terrainHeight).max(0);
  material.colorNode = Fn(() => {
    const normal = normalize(normalWorld);
    const viewDirection = normalize(cameraPosition.sub(positionWorld));
    const facing = max(dot(normal, viewDirection), float(0));
    const fresnel = pow(float(1).sub(facing), uniforms.fresnelPower);
    const baseColor = mix(uniforms.surfaceColor, uniforms.deepColor, smoothstep(0, 7, waterDepth));

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

  material.opacityNode = Fn(() => {
    const shoreBlend = smoothstep(0.05, 4, waterDepth);
    const view = normalize(cameraPosition.sub(positionWorld));
    const grazing = float(1).sub(dot(normalWorld, view).max(0)).pow(4);
    return mix(0.18, 0.96, shoreBlend).max(grazing.mul(0.9)).mul(smoothstep(0, 0.15, waterDepth));
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
  constructor(scene, renderer, terrainRoot, terrainSampler, config, options = {}) {
    this.scene = scene;
    this.params = mergeWaterConfig(config);
    this.renderer = renderer;
    this.river = options.river;
    this.terrain = options.terrain;
    this.enhanced = Boolean(this.river || this.params.sea?.enabled);
    this.cinematic = config.cinematic?.enabled ? config.cinematic.water : null;
    if (this.cinematic) this.params.reflectionResolution = this.cinematic.reflectionResolution;
    this.reflectionElapsed = 10;
    this.reflectionInitialized = false;
    this.rippleElapsed = 0;
    this.rippleIndex = 0;
    this.lastRipple = new THREE.Vector3(1e9, 1e9, 1e9);
    this.stats = { cubeCaptures: 0, lakePlanarCaptures: 0, seaPlanarCaptures: 0 };
    this.lastCubeCaptureMs = 0;
    this.lastPlanarCaptureMs = 0;
    this.nearest = new THREE.Vector3();
    this.quality = config.ui.initialQuality;
    this.geometry = this.enhanced ? createWaterGeometry(this.params, this.river) : new THREE.PlaneGeometry(
      this.params.size,
      this.params.size,
      this.params.segments,
      this.params.segments,
    );
    this.mesh = new THREE.Mesh(this.geometry);
    if (!this.enhanced) this.mesh.rotation.set(-Math.PI * 0.5, 0, 0);
    this.mesh.position.fromArray(this.params.position);
    this.mesh.name = 'River, lake and sea';
    this.mesh.userData.occlusionCull = false;

    this.reflection = captureReflection(scene, renderer, this.mesh, this.params);
    if (this.enhanced) {
      this.lakeReflectionBudget = new ReflectionBudget();
      this.seaReflectionBudget = new ReflectionBudget();
      // Distinct initial textures prevent TSL from sharing the two reflection
      // bindings before their first render targets have been allocated.
      this.reflectionPlaceholders = [new THREE.Texture(), new THREE.Texture()];
      this.planar = reflector({ resolutionScale: this.cinematic?.planarReflectionScale ?? 0.75,
        bounces: false, generateMipmaps: true, defaultTexture: this.reflectionPlaceholders[0] });
      this.planar.target.rotation.x = -Math.PI / 2;
      this.mesh.add(this.planar.target);
      const update = this.planar.reflector.updateBefore.bind(this.planar.reflector);
      this.planar.reflector.updateBefore = (frame) => {
        if (!this.reflectionInitialized || frame.camera !== options.camera || this.quality !== 'ultra') return;
        if (frame.camera.position.x > (this.params.sea?.shoreX ?? Infinity) - 60) return;
        if (!this.lakeReflectionBudget.shouldRender(frame.camera, this.quality, performance.now())) return;
        const hidden = [], shadows = [];
        this.scene.traverse(object => {
          if (object.visible && object.userData.excludeFromReflection) { hidden.push(object); object.visible = false; }
          if (object.isLight && object.shadow) { shadows.push([object.shadow, object.shadow.autoUpdate]); object.shadow.autoUpdate = false; }
        });
        try {
          const started = performance.now();
          update(frame);
          this.lastPlanarCaptureMs = (this.lastPlanarCaptureMs ?? 0) + (performance.now() - started);
          this.stats.lakePlanarCaptures += 1;
        } finally {
          for (const object of hidden) object.visible = true;
          for (const [shadow, autoUpdate] of shadows) shadow.autoUpdate = autoUpdate;
        }
      };
      if (this.params.sea?.enabled) {
        this.seaPlanar = reflector({ resolutionScale: this.cinematic?.planarReflectionScale ?? 0.75,
          bounces: false, generateMipmaps: true, defaultTexture: this.reflectionPlaceholders[1] });
        this.seaPlanar.target.rotation.x = -Math.PI / 2;
        this.seaPlanar.target.position.y = this.params.sea.level - this.params.position[1];
        this.mesh.add(this.seaPlanar.target);
        const updateSea = this.seaPlanar.reflector.updateBefore.bind(this.seaPlanar.reflector);
        this.seaPlanar.reflector.updateBefore = frame => {
          if (!this.reflectionInitialized || frame.camera !== options.camera || this.quality !== 'ultra'
            || frame.camera.position.x < this.params.sea.shoreX - 350) return;
          if (!this.seaReflectionBudget.shouldRender(frame.camera, this.quality, performance.now())) return;
          const hidden = [], shadows = [];
          this.scene.traverse(object => {
            if (object.visible && object.userData.excludeFromReflection) { hidden.push(object); object.visible = false; }
            if (object.isLight && object.shadow) { shadows.push([object.shadow, object.shadow.autoUpdate]); object.shadow.autoUpdate = false; }
          });
          try {
            const started = performance.now();
            updateSea(frame);
            this.lastPlanarCaptureMs = (this.lastPlanarCaptureMs ?? 0) + (performance.now() - started);
            this.stats.seaPlanarCaptures += 1;
          } finally {
            for (const object of hidden) object.visible = true;
            for (const [shadow, autoUpdate] of shadows) shadow.autoUpdate = autoUpdate;
          }
        };
      }
    }
    this.shader = this.enhanced ? createCinematicWaterMaterial({ terrain: terrainSampler.getShaderData(),
      river: this.river, params: this.params, reflection: this.reflection.texture, planar: this.planar, seaPlanar: this.seaPlanar }) : createWaterMaterial(
      this.mesh,
      this.params,
      terrainSampler,
      this.reflection.texture,
    );
    this.material = this.shader.material;
    this.uniforms = this.shader.uniforms;
    this.setQuality(this.quality);
    this.mesh.material = this.material;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.details = this.river ? new RiverDetails(scene, this.river, options.terrain, options.rockSources, options.collisions) : null;

    const collider = terrainRoot?.getObjectByName(config.water?.colliderName ?? 'WaterCollider');
    this.bounds = collider
      ? new THREE.Box3().setFromObject(collider)
      : new THREE.Box3().setFromObject(this.mesh);
  }

  setRain(enabled) {
    if (this.uniforms.rain) this.uniforms.rain.value = enabled ? 1 : 0;
    else this.shader.setRain(enabled);
  }

  setQuality(name) {
    this.quality = name;
    this.lakeReflectionBudget?.reset();
    this.seaReflectionBudget?.reset();
    if (this.uniforms.rich) this.uniforms.rich.value = name === 'ultra' ? 1 : 0;
    if (this.uniforms.seaDetail) this.uniforms.seaDetail.value = { performance: 0.35, balanced: 0.65, high: 0.85, ultra: 1 }[name] ?? 0.85;
    if (this.planar) this.planar.reflector.resolutionScale = { performance: 0.25, balanced: 0.4, high: 0.75, ultra: 1 }[name] ?? 0.75;
    if (this.seaPlanar) this.seaPlanar.reflector.resolutionScale = this.planar.reflector.resolutionScale;
  }

  update(delta, player, lighting) {
    this.rippleElapsed += delta;
    (this.uniforms.clock ?? this.uniforms.rippleClock).value = this.rippleElapsed;
    this.uniforms.sunColor.value.copy(lighting.color);
    this.uniforms.sunDirection.value.copy(lighting.position).normalize();
    this.uniforms.sunStrength.value = (this.enhanced ? 1 : this.params.sunStrength) * Math.min(lighting.directionalIntensity / 3, 1);
    const position = player.getPosition();
    const feetY = position.y - player.metrics.rootToFeet;
    const river = this.river?.sample(position.x, position.z);
    const sea = this.params.sea;
    const atSea = sea?.enabled && position.x > coastX(position.z, sea.shoreX) - 30;
    const surfaceY = river?.edge < 0 ? river.y : atSea ? sea.level : this.mesh.position.y;
    if (player.moving && Math.abs(feetY - surfaceY) < 1.5 && this.containsPoint(position, player.metrics.rootToFeet)
      && position.distanceTo(this.lastRipple) > 0.85) {
      this.uniforms.footsteps.array[this.rippleIndex].set(position.x, position.z, this.rippleElapsed, 1);
      this.rippleIndex = (this.rippleIndex + 1) % this.uniforms.footsteps.array.length;
      this.lastRipple.copy(position);
    }
    // The enhanced upstream probe has a fixed position and represents static
    // surroundings. Weather changes invalidate it; player movement does not.
    if (this.reflectionInitialized && (this.enhanced || !this.cinematic || this.quality === 'performance')) return;
    this.reflectionElapsed += delta;
    this.bounds.clampPoint(position, this.nearest);
    const distance = Math.hypot(position.x - this.nearest.x, position.z - this.nearest.z);
    const interval = (this.cinematic?.reflectionInterval ?? 1) * (this.quality === 'balanced' ? 2 : 1);
    if (this.reflectionInitialized && (distance > this.cinematic.reflectionDistance || this.reflectionElapsed < interval)) return;
    this.reflectionElapsed = 0;
    const camera = this.reflection.cubeCamera;
    // A fixed probe avoids a parallax jump on every refresh while walking.
    // Fine grass uses main-view LOD/clipping and must not enter this cubemap.
    camera.position.set(this.mesh.position.x, this.mesh.position.y + 1, this.mesh.position.z);
    const visible = this.mesh.visible;
    const hidden = [];
    const shadows = [];
    this.scene.traverse((object) => {
      if (object.visible && object.userData.excludeFromReflection) {
        hidden.push(object);
        object.visible = false;
      }
      if (object.isLight && object.shadow) {
        shadows.push([object.shadow, object.shadow.autoUpdate]);
        object.shadow.autoUpdate = false;
      }
    });
    this.mesh.visible = false;
    this.scene.add(camera);
    try {
      const started = performance.now();
      camera.update(this.renderer, this.scene);
      this.lastCubeCaptureMs = performance.now() - started;
      this.reflectionInitialized = true;
      (this.stats ??= { cubeCaptures: 0, lakePlanarCaptures: 0, seaPlanarCaptures: 0 }).cubeCaptures += 1;
    } finally {
      this.mesh.visible = visible;
      for (const object of hidden) object.visible = true;
      for (const [shadow, autoUpdate] of shadows) shadow.autoUpdate = autoUpdate;
      camera.removeFromParent();
    }
  }

  setRainIntensity(value) {
    const intensity = THREE.MathUtils.clamp(Number(value), 0, 1);
    this.setRain(intensity > RAIN_THRESHOLD);
    if (this.uniforms.rain) this.uniforms.rain.value = intensity;
    if (this.enhanced) this.reflectionInitialized = false;
    this.lakeReflectionBudget?.reset();
    this.seaReflectionBudget?.reset();
    if (this.uniforms.rainRippleThickness) {
      this.uniforms.rainRippleThickness.value = THREE.MathUtils.lerp(
        0,
        this.params.rainRippleThickness,
        intensity,
      );
    }
  }

  containsPoint(position, rootToFeet = 1.5) {
    if (this.enhanced) {
      const sea = this.params.sea;
      if (sea?.enabled && position.x > coastX(position.z, sea.shoreX) - 30
        && this.terrain.sampleHeight(position.x, position.z) <= sea.level + 0.05) {
        return position.y - rootToFeet <= sea.level + 0.5;
      }
      const p = this.river?.sample(position.x, position.z);
      if (p?.edge < 0) return position.y - rootToFeet <= p.y + 0.45;
      const half = this.params.size / 2;
      return Math.abs(position.x - this.mesh.position.x) < half && Math.abs(position.z - this.mesh.position.z) < half
        && this.terrain.sampleHeight(position.x, position.z) < this.mesh.position.y
        && position.y - rootToFeet <= this.mesh.position.y + 0.45;
    }
    return position.x >= this.bounds.min.x
      && position.x <= this.bounds.max.x
      && position.z >= this.bounds.min.z
      && position.z <= this.bounds.max.z
      && position.y <= this.bounds.max.y + 1.5;
  }

  dispose() {
    this.details?.dispose();
    this.planar?.dispose();
    this.seaPlanar?.dispose();
    this.reflectionPlaceholders?.forEach(texture => texture.dispose());
    this.shader.dispose?.();
    this.scene?.remove(this.mesh);
    this.material?.dispose?.();
    this.geometry?.dispose?.();
    this.reflection?.renderTarget?.dispose?.();
  }
}
