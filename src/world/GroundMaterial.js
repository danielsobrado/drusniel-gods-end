import * as THREE from 'three/webgpu';
import {
  abs,
  dot,
  float,
  floor,
  fract,
  mix,
  normalMap,
  normalize,
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
} from 'three/tsl';
import { assetUrl } from '../assets/assetUrl.js';

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

function configureBlendMask(textureObject) {
  textureObject.colorSpace = THREE.NoColorSpace;
  textureObject.flipY = false;
  textureObject.wrapS = THREE.ClampToEdgeWrapping;
  textureObject.wrapT = THREE.ClampToEdgeWrapping;
  textureObject.generateMipmaps = true;
  textureObject.minFilter = THREE.LinearMipmapLinearFilter;
  textureObject.magFilter = THREE.LinearFilter;
}

function createRainController(material, baseNormal, config) {
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
    const strength = ring.mul(fade).mul(rippleStrength).mul(enabled);
    const direction = delta.div(distance.max(float(RIPPLE_MIN_DISTANCE)));
    const perturbation = vec3(
      direction.x.negate().mul(strength),
      float(0),
      direction.y.negate().mul(strength),
    );
    return normalize(baseNormal.add(perturbation));
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

export async function createGroundMaterial(config) {
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
  configureBlendMask(blendMask);

  const baseUv = uv();
  const grassUv = baseUv.mul(uniform(ORIGINAL_GRASS_UV_SCALE));
  const groundUv = baseUv.mul(uniform(ORIGINAL_GROUND_UV_SCALE));
  const grassSample = texture(grassColor, grassUv);
  const groundSample = texture(groundColor, groundUv);
  const normalSample = texture(groundNormal, groundUv);
  const roughnessSample = texture(groundRoughness, groundUv).r;
  const blend = texture(blendMask, baseUv).r;

  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'GroundReferenceBlendMaterial';
  material.colorNode = mix(grassSample.rgb, groundSample.rgb, blend);
  const baseNormal = normalMap(normalSample, vec2(blend));
  material.normalNode = baseNormal;
  material.roughnessNode = mix(float(1), roughnessSample, blend);
  material.metalnessNode = float(ORIGINAL_METALNESS);

  const rainController = createRainController(material, baseNormal, config);
  material.userData = {
    ...material.userData,
    textures: [grassColor, groundColor, blendMask, groundNormal, groundRoughness],
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
