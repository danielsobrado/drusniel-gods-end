import * as THREE from 'three/webgpu';
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
  uniformArray,
  vec2,
  vec3,
} from 'three/tsl';

const TWO_PI = Math.PI * 2;
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
const EMISSIVE_COLOR = new THREE.Color(0.003, 0.015, 0.018);

export function createLegacyWaterMaterial(mesh, params, terrainSampler, reflectionTexture) {
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
    return value.mul(0.75).add(value.mul(value).mul(value).mul(0.25)).mul(amplitude);
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
    const randomA = fract(sin(dot(cell, vec2(127.1, 311.7))).mul(RIPPLE_HASH_SCALE));
    const randomB = fract(sin(dot(cell, vec2(269.5, 183.3))).mul(RIPPLE_HASH_SCALE));
    const offset = vec2(randomA.sub(0.5), randomB.sub(0.5)).mul(uniforms.rainRippleRandomness);
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
    for (let i = 0; i < 6; i += 1) {
      const impact = uniforms.footsteps.element(i);
      const age = uniforms.rippleClock.sub(impact.z).max(0);
      const delta = positionWorld.xz.sub(impact.xy);
      const distance = delta.length().max(0.01);
      const ring = distance.sub(age.mul(2.8));
      const value = sin(ring.mul(15)).mul(ring.pow(2).mul(-6).exp())
        .mul(age.mul(-1.3).exp()).mul(impact.w).mul(0.12);
      offset.addAssign(vec3(
        delta.x.div(distance).mul(value),
        delta.y.div(distance).mul(value).negate(),
        0,
      ));
    }
    return offset;
  });
  const rebuildNormal = () => {
    material.normalNode = Fn(() => {
      const normal = normalize(baseNormal(positionLocal.xy, time.mul(uniforms.speed)).add(footNormal()));
      if (!rainy || !params.rainRipples) return transformNormalToView(normal);
      return transformNormalToView(normalize(normal.add(rainNormal().sub(vec3(0, 0, 1)))));
    })();
    material.needsUpdate = true;
  };
  rebuildNormal();

  const reflectionNode = reflectionTexture ? cubeTexture(reflectionTexture) : null;
  const terrainMin = vec2(terrain.boundsMin.x, terrain.boundsMin.z);
  const terrainSize = vec2(terrain.boundsSize.x, terrain.boundsSize.z);
  const terrainUv = positionWorld.xz.sub(terrainMin).div(terrainSize);
  const terrainHeight = mix(
    float(terrain.minHeight),
    float(terrain.maxHeight),
    texture(terrain.texture, terrainUv).r,
  );
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
    const sunHighlight = pow(sunFacing, float(90)).mul(uniforms.sunColor).mul(uniforms.sunStrength);
    const sunGlint = pow(sunFacing, float(12)).mul(uniforms.sunColor).mul(uniforms.sunStrength).mul(0.15);
    const sunDiffuse = max(dot(uniforms.sunDirection, normal), float(0)).mul(uniforms.sunColor).mul(0.12);
    return mix(
      baseColor.add(sunDiffuse),
      reflection.add(sunHighlight).add(sunGlint),
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
