import * as THREE from 'three/webgpu';
import {
  abs,
  cameraViewMatrix,
  cameraPosition,
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
import { cloudShade } from '../rendering/cloudShadow.js';
import { getPresetAppearance, sampleReferenceField } from '../rendering/PresetAppearance.js';
import { groundGrassTexture, groundRoughness as turfRoughness, groundTurf } from '../rendering/GroundTurf.js';
import { riverField } from '../water/riverNodes.js';
import { advanceBeachMoisture, createCoastNodes, resolveCoastConfig } from './CoastField.js';
import { createGroundTextureSamples } from './GroundTextureBlend.js';
import { createRockSurfaceNodes } from './RockSurface.js';
import { createSnowSurfaceNodes } from './SnowSurface.js';

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

function configureSurfaceBlend(textureObject, flipY = false) {
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
    const randomA = fract(sin(dot(cell, vec2(127.1, 311.7))).mul(RIPPLE_HASH_SCALE));
    const randomB = fract(sin(dot(cell, vec2(269.5, 183.3))).mul(RIPPLE_HASH_SCALE));
    const enabled = step(randomA, rippleAmount);
    const timer = time.mul(rippleSpeed).add(randomB);
    const cycle = floor(timer);
    const phase = fract(timer);
    const shiftedCell = cell.add(cycle);
    const offsetX = fract(sin(dot(shiftedCell, vec2(157.3, 271.9))).mul(RIPPLE_HASH_SCALE));
    const offsetY = fract(sin(dot(shiftedCell, vec2(381.7, 129.4))).mul(RIPPLE_HASH_SCALE));
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

export async function createGroundMaterial(config, terrainSampler = null, snowDeformation = null) {
  const loader = new THREE.TextureLoader();
  const groundAssets = config.assets?.ground ?? {};
  const paths = {
    grass: config.assets?.grassTexture,
    color: groundAssets.color,
    blend: config.assets?.groundBlend,
    normal: groundAssets.normal,
    roughness: groundAssets.roughness,
  };
  if (Object.values(paths).some((path) => !path)) {
    throw new Error('Ground blend textures are not fully configured.');
  }

  const [grassColor, groundColor, surfaceBlend, groundNormal, groundRoughness] = await Promise.all([
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
  configureSurfaceBlend(surfaceBlend, Boolean(meadowStyle));

  const baseUv = uv();
  const grassUv = baseUv.mul(uniform(config.ground.grassTextureScale ?? ORIGINAL_GRASS_UV_SCALE));
  const groundUv = baseUv.mul(uniform(config.ground.groundTextureScale ?? ORIGINAL_GROUND_UV_SCALE));
  const grassSample = config.cinematic?.enabled
    ? groundGrassTexture(grassColor, grassUv, positionWorld.xz).toVar()
    : texture(grassColor, grassUv).rgb;
  const groundSamples = createGroundTextureSamples({
    config,
    colorTexture: groundColor,
    normalTexture: groundNormal,
    roughnessTexture: groundRoughness,
    primaryUv: groundUv,
  });
  const groundSample = groundSamples.color;
  const normalSample = groundSamples.normal;
  const roughnessSample = groundSamples.roughness;
  const blendUv = config.terrain.expansion?.enabled
    ? positionWorld.xz.add(480).div(960).clamp(0, 1)
    : meadowStyle && terrainSampler
      ? positionWorld.xz.sub(vec2(terrainSampler.bounds.min.x, terrainSampler.bounds.min.z))
        .div(vec2(terrainSampler.size.x, terrainSampler.size.z)).clamp(0, 1)
      : baseUv;
  const blendSample = texture(surfaceBlend, blendUv);
  const insideAuthored = positionWorld.x.abs().lessThan(480).and(positionWorld.z.abs().lessThan(480));
  const blend = terrainSampler?.paths?.texture
    ? texture(terrainSampler.paths.texture, positionWorld.xz.sub(vec2(terrainSampler.bounds.min.x, terrainSampler.bounds.min.z))
      .div(vec2(terrainSampler.size.x, terrainSampler.size.z))).r
    : config.terrain.expansion?.enabled ? insideAuthored.select(blendSample.r, float(0)) : blendSample.r;
  const soil = config.cinematic?.enabled ? smoothstep(0.12, 0.88, blend) : float(1);
  const appearance = getPresetAppearance(config);
  const field = sampleReferenceField(positionWorld.xz, config);
  const soilPaint = mix(soil, soil.max(field.a), appearance.enabled);

  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'GroundReferenceBlendMaterial';
  material.colorNode = mix(grassSample.rgb, groundSample.rgb, blend);
  const normalStrength = config.ground.normalStrength ?? 1;
  let baseNormal = normalMap(
    normalSample,
    vec2(blend.mul(normalStrength), blend.mul(normalStrength * (config.ground.normalY ?? 1))),
  );
  material.normalNode = baseNormal;
  material.roughnessNode = mix(float(1), roughnessSample, blend);
  material.metalnessNode = float(config.ground.metalness ?? ORIGINAL_METALNESS);

  const wetness = uniform(0);
  const coastClock = uniform(0), coastRain = uniform(0), beachMoisture = uniform(0);
  let snowLighting = null;
  if (config.cinematic?.enabled) {
    const world = positionWorld.xz;
    const macro = sin(world.x.mul(0.037).add(sin(world.y.mul(0.053))))
      .mul(sin(world.y.mul(0.071))).mul(0.5).add(0.5);
    // Flecks are a 1-2 m sine product: sub-pixel beyond ~60 m, where they
    // alias into a diagonal beat lattice on distant slopes, so fade them out.
    const fleckFade = cameraPosition.distance(positionWorld).smoothstep(35, 90).oneMinus();
    const flecks = mix(0.5, sin(world.x.mul(3.1)).mul(sin(world.y.mul(4.7))).mul(0.5).add(0.5), fleckFade);
    const moss = macro.mul(normalWorld.y.max(0)).mul(blend.oneMinus()).mul(0.22);
    const style = config.cinematic.style;
    const turf = style?.enabled ? groundTurf(world).toVar() : vec3(0);
    if (style?.enabled) {
      const turfSlope = vec3(turf.y, 0, turf.z).mul(soilPaint.oneMinus());
      baseNormal = normalize(baseNormal.add(cameraViewMatrix.mul(vec4(turfSlope, 0)).xyz));
      material.normalNode = baseNormal;
    }
    // Turf sits slightly darker than the blade pigment so it reads as shaded
    // soil beneath the canopy rather than a painted lawn.
    const grassPaint = style?.enabled
      ? meadowRootColor(world, config).mul(grassSample.g.mul(0.08).add(0.96)).mul(turf.x.mul(0.12).add(1)).mul(0.72)
      : grassSample.rgb;
    const pathPaint = style?.enabled
      ? mix(groundSample.rgb, color(style.groundPath).mul(groundSample.r.mul(0.65).add(0.65)), 0.48)
      : groundSample.rgb;
    // Break the low-resolution path mask contour with the turf fibre and macro
    // noise already computed, so grass and soil interpenetrate at the edge.
    const ditheredSoil = smoothstep(0.12, 0.88, blend.add(turf.x.mul(0.09)).add(macro.sub(0.5).mul(0.06)));
    const soilEdge = style?.enabled ? mix(ditheredSoil, ditheredSoil.max(field.a), appearance.enabled) : soilPaint;
    const earth = mix(grassPaint, pathPaint, soilEdge);
    const variation = mix(1 - (config.ground.macroVariation ?? 0.2), 1.08, macro);
    const river = riverField(terrainSampler?.river).toVar();
    const riverBank = river.y.smoothstep(-1, 6).oneMinus();
    const bank = positionWorld.y.sub(config.water.position[1]).abs().smoothstep(0.2, 2.8).oneMinus()
      .max(positionWorld.y.sub(river.x).abs().smoothstep(0.2, 3.5).oneMinus().mul(riverBank));
    const wet = wetness.max(bank.mul(0.65));
    material.colorNode = style?.enabled
      ? earth.mul(mix(1, variation.mul(mix(0.94, 1.04, flecks)), blend)).mul(wet.mul(0.16).oneMinus()).mul(cloudShade())
      : mix(earth, earth.mul(vec3(0.7, 0.87, 0.56)), moss)
        .mul(variation).mul(mix(0.94, 1.04, flecks)).mul(wet.mul(0.28).oneMinus());
    if (style?.enabled) material.emissiveNode = earth.mul(foliageLight.fill).mul(appearance.grassFill);
    material.roughnessNode = turfRoughness(soilPaint, roughnessSample, wet, turf.x);

    if (terrainSampler?.river || config.terrain.expansion?.enabled || config.water.sea?.enabled) {
      const lakeInside = positionWorld.x.sub(config.water.position[0]).abs().lessThan(config.water.size / 2)
        .and(positionWorld.z.sub(config.water.position[2]).abs().lessThan(config.water.size / 2));
      const lakeBed = lakeInside.select(
        float(config.water.position[1]).sub(positionWorld.y).smoothstep(-0.8, 0.4),
        float(0),
      );
      const rockSurface = createRockSurfaceNodes({
        config,
        colorTexture: groundColor,
        roughnessTexture: groundRoughness,
        macro,
        wet,
        riverBank,
        lakeBed,
      });
      material.colorNode = mix(material.colorNode, rockSurface.color, rockSurface.mask);
      material.roughnessNode = mix(material.roughnessNode, rockSurface.roughness, rockSurface.mask);
      baseNormal = normalize(mix(baseNormal, rockSurface.normal, rockSurface.mask));
      material.normalNode = baseNormal;

      const terrainEmissive = (material.emissiveNode ?? vec3(0)).mul(rockSurface.mask.oneMinus());
      if (config.ground.snow?.enabled) {
        const snow = createSnowSurfaceNodes(config, snowDeformation);
        snowLighting = snow.lighting;
        material.colorNode = mix(material.colorNode, snow.color, snow.mask);
        material.roughnessNode = mix(material.roughnessNode, snow.roughness, snow.mask);
        material.metalnessNode = mix(material.metalnessNode, float(0), snow.mask);
        baseNormal = normalize(mix(baseNormal, snow.normal, snow.mask));
        material.normalNode = baseNormal;
        material.emissiveNode = terrainEmissive.mul(snow.mask.oneMinus()).add(snow.emissive);
      } else {
        material.emissiveNode = terrainEmissive;
      }

      const sea = config.water.sea;
      const resolvedSea = sea?.enabled ? resolveCoastConfig(sea) : null;
      const coast = resolvedSea ? createCoastNodes(resolvedSea, coastClock, coastRain) : null;
      const sandParams = resolvedSea?.coast.sand;
      const coastal = coast
        ? coast.distance(world).smoothstep(sandParams.inlandStart, sandParams.inlandEnd)
        : float(0);
      if (resolvedSea) {
        const sandMacro = sin(world.x.mul(sandParams.macroFrequency)
          .add(sin(world.y.mul(sandParams.macroFrequency * 1.43))))
          .mul(sin(world.y.mul(sandParams.macroFrequency * 1.92))).mul(0.5).add(0.5);
        const sandRipples = sin(world.y.mul(sandParams.rippleFrequency)
          .add(sin(world.x.mul(sandParams.rippleCrossFrequency)).mul(2)))
          .mul(sandParams.rippleStrength).add(1 - sandParams.rippleStrength);
        const grainFade = cameraPosition.distance(positionWorld)
          .smoothstep(sandParams.grainFadeStart, sandParams.grainFadeEnd).oneMinus();
        const sandGrains = sin(world.x.mul(sandParams.grainFrequencyX))
          .mul(sin(world.y.mul(sandParams.grainFrequencyZ)))
          .mul(sandParams.grainStrength).mul(grainFade).add(1 - sandParams.grainStrength);
        const meso = sin(world.x.mul(sandParams.mesoFrequencyX)
          .add(sin(world.y.mul(sandParams.mesoFrequencyX * 1.25))))
          .mul(sin(world.y.mul(sandParams.mesoFrequencyZ))).mul(0.5).add(0.5);
        const coverage = coast.waterCoverage(world);
        const groundHandoff = coast.seaCoverage(world).oneMinus();
        const memory = coast.washMemory(world);
        const wetSand = coast.baseMoisture(world).mul(sandParams.baseMoistureStrength).mul(mix(sandParams.mesoWetMin, sandParams.mesoWetMax, meso))
          .add(memory.mul(sandParams.washMemoryStrength))
          .add(beachMoisture.mul(sandParams.rainMoistureStrength))
          .add(coverage.mul(sandParams.coverageWetness))
          .clamp(0, 1);
        const drySand = mix(color(sandParams.dryDark), color(sandParams.dryLight), sandMacro)
          .mul(sandRipples).mul(sandGrains).mul(mix(sandParams.mesoToneMin, sandParams.mesoToneMax, meso));
        const saturatedSand = drySand.mul(wetSand.mul(sandParams.wetDarkening).oneMinus());
        const film = coverage.mul(groundHandoff);
        const foam = coast.foamFront(world).mul(groundHandoff).mul(sandParams.foamStrength);
        const filmColor = mix(saturatedSand, color(sandParams.filmTint), film.mul(sandParams.filmTintStrength));
        const beachColor = mix(filmColor, color(sandParams.foamColor), foam.clamp(0, 1));
        material.colorNode = mix(material.colorNode, beachColor, coastal);
        const sandRoughness = mix(
          sandParams.dryRoughness,
          sandParams.wetRoughness,
          wetSand.pow(2),
        );
        const filmRoughness = mix(sandRoughness, sandParams.filmRoughness, film);
        material.roughnessNode = mix(
          material.roughnessNode,
          mix(filmRoughness, sandParams.foamRoughness, foam),
          coastal,
        );
        material.metalnessNode = mix(material.metalnessNode, float(0), coastal);
        const sandSlope = vec3(
          sin(world.x.mul(sandParams.normalFrequencyX)),
          0,
          sin(world.y.mul(sandParams.normalFrequencyZ)),
        ).mul(sandParams.normalStrength)
          .mul(wetSand.mul(sandParams.wetNormalFlattening).oneMinus())
          .mul(film.mul(sandParams.filmNormalFlattening).oneMinus())
          .mul(grainFade);
        const sandNormal = normalize(cameraViewMatrix.mul(vec4(normalWorld.add(sandSlope), 0)).xyz);
        baseNormal = normalize(mix(baseNormal, sandNormal, coastal));
        material.normalNode = baseNormal;
      }
      material.emissiveNode = (material.emissiveNode ?? vec3(0)).mul(coastal.oneMinus());

      const inlandY = river.y.lessThan(0).select(river.x, float(config.water.position[1]));
      const surfaceY = coastal.greaterThan(0.5).select(float(resolvedSea?.level ?? -24), inlandY);
      const depth = surfaceY.sub(positionWorld.y);
      const submerged = depth.smoothstep(0.02, 0.3).mul(depth.smoothstep(1, 5).oneMinus());
      const caustic = sin(world.x.mul(2.7).add(time.mul(0.7)).add(sin(world.y.mul(2.1))))
        .mul(sin(world.y.mul(2.3).sub(time.mul(0.55)).add(sin(world.x.mul(2.5)))))
        .abs().pow(14);
      material.emissiveNode = (material.emissiveNode ?? vec3(0))
        .add(color('#c7e9d0').mul(caustic).mul(submerged).mul(foliageLight.fill).mul(0.32));
    }
  }

  const rainController = createRainController(material, baseNormal, config, soilPaint);
  material.userData = {
    ...material.userData,
    textures: [grassColor, groundColor, surfaceBlend, groundNormal, groundRoughness],
    updateCoast: (delta, clock) => {
      coastClock.value = clock;
      beachMoisture.value = advanceBeachMoisture(
        beachMoisture.value,
        coastRain.value,
        delta,
        config.water.sea,
      );
    },
    beachMoisture,
    setSnowLighting: (direction, tint, intensity) => snowLighting?.set(direction, tint, intensity),
    setRainIntensity: (value) => {
      coastRain.value = THREE.MathUtils.clamp(value, 0, 1);
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
