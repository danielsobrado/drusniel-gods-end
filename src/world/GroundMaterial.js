import * as THREE from 'three/webgpu';
import {
  abs,
  cameraViewMatrix,
  color,
  dot,
  float,
  floor,
  fract,
  mix,
  normalMap,
  normalize,
  normalWorld,
  positionWorld,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { assetUrl } from '../assets/assetUrl.js';
import { foliageLight } from '../rendering/CinematicLighting.js';
import { meadowRootColor } from '../rendering/MeadowPalette.js';
import { groundRoughness as turfRoughness, groundTurf } from '../rendering/GroundTurf.js';

const ORIGINAL_ANISOTROPY = 16;
const ORIGINAL_GRASS_UV_SCALE = 150;
const ORIGINAL_GROUND_UV_SCALE = 70;
const ORIGINAL_METALNESS = 0.5;
const RIPPLE_HASH_SCALE = 43758.5453;
const RIPPLE_MIN_DISTANCE = 0.001;
const RIPPLE_OFFSET_SCALE = 0.65;
const DEFAULT_RIPPLE = Object.freeze({
  scale: 1.5,
  size: 0.38,
  thickness: 0.1,
  strength: 3,
  speed: 2,
  amount: 0.7,
});

function configureRepeatedTexture(textureObject, colorSpace) {
  textureObject.colorSpace = colorSpace;
  textureObject.wrapS = THREE.RepeatWrapping;
  textureObject.wrapT = THREE.RepeatWrapping;
  textureObject.generateMipmaps = true;
  textureObject.minFilter = THREE.LinearMipmapLinearFilter;
  textureObject.magFilter = THREE.LinearFilter;
  textureObject.anisotropy = ORIGINAL_ANISOTROPY;
}

function configureBlendMask(textureObject, flipY = false) {
  textureObject.colorSpace = THREE.NoColorSpace;
  textureObject.flipY = flipY;
  textureObject.wrapS = THREE.ClampToEdgeWrapping;
  textureObject.wrapT = THREE.ClampToEdgeWrapping;
  textureObject.generateMipmaps = true;
  textureObject.minFilter = THREE.LinearMipmapLinearFilter;
  textureObject.magFilter = THREE.LinearFilter;
}

function createRainController(material, baseNormal, config, soil) {
  const params = { ...DEFAULT_RIPPLE, ...(config.ground.rainRipple ?? {}) };
  const rippleScale = uniform(params.scale);
  const rippleSize = uniform(params.size);
  const rippleThickness = uniform(params.thickness);
  const rippleStrength = uniform(params.strength);
  const rippleSpeed = uniform(params.speed);
  const rippleAmount = uniform(params.amount);
  let rain = false;
  let rainNormal = null;

  const buildRainNormal = () => {
    const world = positionWorld.xz.mul(rippleScale);
    const cell = floor(world);
    const local = fract(world).sub(0.5);

    const randomA = fract(
      sin(dot(cell, vec2(127.1, 311.7))).mul(RIPPLE_HASH_SCALE),
    );
    const randomB = fract(
      sin(dot(cell, vec2(269.5, 183.3))).mul(RIPPLE_HASH_SCALE),
    );
    const enabled = step(randomA, rippleAmount);

    const timer = time.mul(rippleSpeed).add(randomB);
    const cycle = floor(timer);
    const phase = fract(timer);
    const shiftedCell = cell.add(cycle);
    const offsetX = fract(
      sin(dot(shiftedCell, vec2(157.3, 271.9))).mul(RIPPLE_HASH_SCALE),
    );
    const offsetY = fract(
      sin(dot(shiftedCell, vec2(381.7, 129.4))).mul(RIPPLE_HASH_SCALE),
    );
    const offset = vec2(offsetX.sub(0.5), offsetY.sub(0.5)).mul(RIPPLE_OFFSET_SCALE);

    const delta = local.sub(offset);
    const distance = sqrt(dot(delta, delta));
    const radius = phase.mul(rippleSize);
    const error = abs(distance.sub(radius));
    const ring = float(1).sub(smoothstep(float(0), rippleThickness, error));
    const fade = float(1).sub(phase);
    const strength = ring.mul(fade).mul(rippleStrength).mul(enabled).mul(soil);
    const direction = delta.div(distance.max(float(RIPPLE_MIN_DISTANCE)));
    const perturbation = vec3(
      direction.x.negate().mul(strength),
      float(0),
      direction.y.negate().mul(strength),
    );
    // normalNode is view-space; the ripple direction is anchored in the world.
    return normalize(baseNormal.add(cameraViewMatrix.mul(vec4(perturbation, 0)).xyz));
  };

  return {
    rippleScale,
    rippleSize,
    rippleThickness,
    rippleStrength,
    rippleSpeed,
    rippleAmount,
    get rain() {
      return rain;
    },
    setRain(enabled) {
      const next = Boolean(enabled);
      if (rain === next) return;
      rain = next;
      if (rain) {
        rainNormal ??= buildRainNormal();
        material.normalNode = rainNormal;
      } else {
        material.normalNode = baseNormal;
      }
      material.needsUpdate = true;
    },
  };
}

export async function createGroundMaterial(config, terrainSampler = null) {
  const loader = new THREE.TextureLoader();
  const groundAssets = config.assets?.ground ?? {};
  const paths = {
    grass: config.assets?.grassTexture,
    color: groundAssets.color,
    blend: config.assets?.grassMask,
    normal: groundAssets.normal,
    roughness: groundAssets.roughness,
  };
  if (Object.values(paths).some((path) => !path)) {
    throw new Error('Ground blend textures are not fully configured.');
  }

  const [grassColor, groundColor, blendMask, groundNormal, groundRoughness] = await Promise.all([
    loader.loadAsync(assetUrl(paths.grass)),
    loader.loadAsync(assetUrl(paths.color)),
    loader.loadAsync(assetUrl(paths.blend)),
    loader.loadAsync(assetUrl(paths.normal)),
    loader.loadAsync(assetUrl(paths.roughness)),
  ]);

  configureRepeatedTexture(grassColor, THREE.SRGBColorSpace);
  configureRepeatedTexture(groundColor, THREE.SRGBColorSpace);
  configureRepeatedTexture(groundNormal, THREE.NoColorSpace);
  configureRepeatedTexture(groundRoughness, THREE.NoColorSpace);
  const meadowStyle = config.cinematic?.enabled && config.cinematic.style?.enabled;
  configureBlendMask(blendMask, Boolean(meadowStyle));

  const baseUv = uv();
  const grassUv = baseUv.mul(uniform(config.ground.grassTextureScale ?? ORIGINAL_GRASS_UV_SCALE));
  const groundUv = baseUv.mul(uniform(config.ground.groundTextureScale ?? ORIGINAL_GROUND_UV_SCALE));
  const grassSample = texture(grassColor, grassUv);
  const groundSample = texture(groundColor, groundUv);
  const normalSample = texture(groundNormal, groundUv);
  const roughnessSample = texture(groundRoughness, groundUv).r;
  // Match the vegetation's world projection and CanvasTexture orientation.
  // Mesh UVs plus an unflipped image previously painted grass on cleared paths.
  const maskUv = meadowStyle && terrainSampler
    ? positionWorld.xz.sub(vec2(terrainSampler.bounds.min.x, terrainSampler.bounds.min.z))
      .div(vec2(terrainSampler.size.x, terrainSampler.size.z)).clamp(0, 1)
    : baseUv;
  const maskSample = texture(blendMask, maskUv);
  const blend = maskSample.r;
  const soil = config.cinematic?.enabled ? smoothstep(0.12, 0.88, blend) : float(1);

  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'GroundReferenceBlendMaterial';
  material.colorNode = mix(grassSample.rgb, groundSample.rgb, blend);
  const normalStrength = config.ground.normalStrength ?? 1;
  let baseNormal = normalMap(normalSample, vec2(blend.mul(normalStrength), blend.mul(normalStrength * (config.ground.normalY ?? 1))));
  material.normalNode = baseNormal;
  material.roughnessNode = mix(float(1), roughnessSample, blend);
  material.metalnessNode = float(config.ground.metalness ?? ORIGINAL_METALNESS);

  const wetness = uniform(0);
  if (config.cinematic?.enabled) {
    const world = positionWorld.xz;
    const macro = sin(world.x.mul(0.037).add(sin(world.y.mul(0.053)))).mul(sin(world.y.mul(0.071))).mul(0.5).add(0.5);
    const flecks = sin(world.x.mul(3.1)).mul(sin(world.y.mul(4.7))).mul(0.5).add(0.5);
    const moss = macro.mul(normalWorld.y.max(0)).mul(blend.oneMinus()).mul(0.22);
    const style = config.cinematic.style;
    const turf = style?.enabled ? groundTurf(world).toVar() : vec3(0);
    if (style?.enabled) {
      const turfSlope = vec3(turf.y, 0, turf.z).mul(soil.oneMinus());
      baseNormal = normalize(baseNormal.add(cameraViewMatrix.mul(vec4(turfSlope, 0)).xyz));
      material.normalNode = baseNormal;
    }
    const grassPaint = style?.enabled
      ? meadowRootColor(world, config).mul(grassSample.g.mul(0.08).add(0.96)).mul(turf.x.mul(0.12).add(1))
      : grassSample.rgb;
    const pathPaint = style?.enabled
      ? mix(groundSample.rgb, color(style.groundPath).mul(groundSample.r.mul(0.65).add(0.65)), 0.48)
      : groundSample.rgb;
    const earth = mix(grassPaint, pathPaint, soil);
    const variation = mix(1 - (config.ground.macroVariation ?? 0.2), 1.08, macro);
    const bank = positionWorld.y.sub(config.water.position[1]).abs().smoothstep(0.2, 2.8).oneMinus();
    const wet = wetness.max(bank.mul(0.65));
    material.colorNode = style?.enabled
      ? earth.mul(mix(1, variation.mul(mix(0.94, 1.04, flecks)), blend)).mul(wet.mul(0.16).oneMinus())
      : mix(earth, earth.mul(vec3(0.7, 0.87, 0.56)), moss)
        .mul(variation).mul(mix(0.94, 1.04, flecks)).mul(wet.mul(0.28).oneMinus());
    if (style?.enabled) material.emissiveNode = earth.mul(foliageLight.fill).mul(style.grassFill ?? 0.06);
    material.roughnessNode = turfRoughness(soil, roughnessSample, wet, turf.x);
  }

  const rainController = createRainController(material, baseNormal, config, soil);
  material.userData = {
    ...material.userData,
    textures: [grassColor, groundColor, blendMask, groundNormal, groundRoughness],
    // Borrow the live authoring texture; GrassMask owns its lifetime. The raw
    // strokes retain a soft soil/turf fringe around vegetation's clearance.
    setGrassMask: (mask) => { if (meadowStyle) maskSample.value = mask.texture; },
    setRainIntensity: (value) => {
      wetness.value = value * (config.ground.wetness ?? 0.7);
      rainController.setRain(value > 0.001);
    },
    rippleScale: rainController.rippleScale,
    rippleSize: rainController.rippleSize,
    rippleThickness: rainController.rippleThickness,
    rippleStrength: rainController.rippleStrength,
    rippleSpeed: rainController.rippleSpeed,
    rippleAmount: rainController.rippleAmount,
    setRain: (enabled) => rainController.setRain(enabled),
  };
  Object.defineProperty(material.userData, 'rain', {
    enumerable: true,
    get: () => rainController.rain,
  });
  return material;
}
