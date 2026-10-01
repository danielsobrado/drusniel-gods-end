import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  cameraViewMatrix,
  cameraPosition,
  color,
  dot,
  float,
  floor,
  fract,
  fwidth,
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
import { getSnowTextures } from './snowTextures.js';
import { meadowRootColor } from '../rendering/MeadowPalette.js';
import { cloudShade } from '../rendering/cloudShadow.js';
import { getPresetAppearance, sampleReferenceField } from '../rendering/PresetAppearance.js';
import { groundGrassTexture, groundRoughness as turfRoughness, groundTurf } from '../rendering/GroundTurf.js';
import { riverField } from '../water/riverNodes.js';
import { advanceBeachMoisture, coastXNode, createCoastNodes, resolveCoastConfig, SEA_SHORE_OPACITY_END, SEA_SHORE_OPACITY_START } from './CoastField.js';
import { createGroundTextureSamples } from './GroundTextureBlend.js';
import { createRockSurfaceNodes } from './RockSurface.js';
import { createDeformationNodes, createSnowIceNodes, createSnowSurfaceNodes } from './SnowSurface.js';
import { ambientUniforms } from '../weather/ambientUniforms.js';
import { blownStreaks } from '../weather/blownStreaks.js';
import { snowGlints } from './snowShadingNodes.js';
import { resolveVegetationPolicy } from '../grass/vegetationPolicy.js';
import { getSurfaceDetail } from '../rendering/surfaceDetail.js';
import { noise2 } from './snowNoiseNodes.js';
import { heightBlend, heightfieldCurvature, luminance, pebbleColor, pebbleField } from './surfaceDetailNodes.js';
import { resolveRockSurfaceConfig } from './RockSurface.js';

// Rock palette for scree: the stones are the terrain's own rock tones.
const SCREE_PALETTE = ['#4d4c49', '#6e6c66', '#857c6c', '#9d9a92'];
const SCREE_GRIT = '#5b5750';
// Beach stones are sea-worn and sun-bleached: pale grey, sandstone and shell
// white. The dark basalt of the default palette read as holes in the sand.
const BEACH_PEBBLE_PALETTE = ['#8d877c', '#aaa597', '#b59e7c', '#e4ddcc'];
// Weed and algae stain at the waterline.
const ALGAE_TINT = [0.5, 0.58, 0.44];

// Gradient noise evaluated only where `weight` is above zero (0 elsewhere):
// most of these detail terms are masked to a small part of the terrain, and
// the terrain covers most of the screen. Arithmetic only, so the branch is
// safe in non-uniform control flow.
function gatedNoise(weight, point) {
  return Fn(() => {
    const value = float(0).toVar();
    If(weight.greaterThan(0), () => {
      value.assign(noise2(point));
    });
    return value;
  })();
}

const ORIGINAL_ANISOTROPY = 16;
const ORIGINAL_GRASS_UV_SCALE = 150;
const ORIGINAL_GROUND_UV_SCALE = 70;
const ORIGINAL_METALNESS = 0.5;
// Depth below the sea at which beach swash gives way entirely: past it the
// ground is bed, not shore, and whatever floats above it does the shading.
const SUBMERGED_SWASH_DEPTH = 0.9;
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
    normal: groundAssets.normal,
    roughness: groundAssets.roughness,
  };
  if (Object.values(paths).some((path) => !path)) {
    throw new Error('Ground blend textures are not fully configured.');
  }

  const [grassColor, groundColor, groundNormal, groundRoughness] = await Promise.all([
    loader.loadAsync(assetUrl(paths.grass)),
    loader.loadAsync(assetUrl(paths.color)),
    loader.loadAsync(assetUrl(paths.normal)),
    loader.loadAsync(assetUrl(paths.roughness)),
  ]);

  configureRepeatedTexture(grassColor, THREE.SRGBColorSpace);
  configureRepeatedTexture(groundColor, THREE.SRGBColorSpace);
  configureRepeatedTexture(groundNormal, THREE.NoColorSpace);
  configureRepeatedTexture(groundRoughness, THREE.NoColorSpace);

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
  // One path sample: R is the path mask, G the grass field's exclusion.
  const pathField = terrainSampler?.paths?.texture
    ? texture(terrainSampler.paths.texture, positionWorld.xz.sub(vec2(terrainSampler.bounds.min.x, terrainSampler.bounds.min.z))
      .div(vec2(terrainSampler.size.x, terrainSampler.size.z)))
    : null;
  const blend = pathField ? pathField.r : float(0);
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
  if (config.cinematic?.enabled) {
    const world = positionWorld.xz;
    // Surface detail (surfaceDetail config): live strengths and the terrain
    // curvature, computed once here and shared by rock, scree and snow.
    const detail = getSurfaceDetail(config);
    const curvatureStep = config.ground.snow?.accumulation?.curvatureStep ?? detail.settings.rock.curvature.step;
    const curvature = terrainSampler ? heightfieldCurvature(terrainSampler, world, curvatureStep) : null;
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
    let earth = mix(grassPaint, pathPaint, soilEdge);
    if (style?.enabled && pathField) {
      // Where the grass field grows no blades but the path mask still says
      // turf (path clearance, tree shade), bare turf read as a flat painted
      // lawn. Paint it as worn, trampled ground instead: duller and browner,
      // broken by soil patches, with a faint contact shade where blades start.
      // The exclusion (path texture G) is 0 until grass fills it in.
      const policy = resolveVegetationPolicy(config);
      // Blade height strength, as the grass shader computes it: short edge
      // blades cover little, so the turf under them wears too.
      const raw = pathField.g.oneMinus();
      const growth = raw.mul(raw.smoothstep(policy.cutoff, policy.cutoff + policy.softness)).smoothstep(0.3, 0.8);
      const wear = growth.oneMinus().mul(soilEdge.oneMinus());
      const patches = sin(world.x.mul(0.61).add(sin(world.y.mul(0.43)).mul(1.7)))
        .mul(sin(world.y.mul(0.57).add(sin(world.x.mul(0.37)).mul(1.3)))).mul(0.5).add(0.5);
      const soilPatch = patches.add(turf.x.mul(0.35)).add(flecks.sub(0.5).mul(0.3)).smoothstep(0.45, 0.85);
      const dull = mix(vec3(dot(grassPaint, vec3(0.3, 0.59, 0.11))), grassPaint, 0.5).mul(vec3(1, 0.94, 0.76));
      const worn = mix(dull, pathPaint.mul(0.92), soilPatch.mul(0.55).add(0.18));
      const contact = growth.mul(growth.oneMinus()).mul(4).mul(soilEdge.oneMinus()).mul(0.12);
      // Trunks and rocks sit in a soft shade of their own (path texture B):
      // bare ground there turns to darker leaf-litter duff, then darkens
      // toward the contact point.
      const footprint = pathField.b;
      const duff = mix(dull.mul(0.45), pathPaint.mul(vec3(0.42, 0.35, 0.26)), 0.5);
      // Under standing grass the ground is the sward's own shadowed base: dark
      // and deep, so gaps between near blades read as depth, not bare lawn.
      const sward = growth.mul(soilEdge.oneMinus());
      earth = mix(earth, earth.mul(vec3(0.46, 0.5, 0.4).mul(appearance.groundSwardShade))
        .mul(patches.mul(0.3).add(0.85)), sward);
      earth = mix(earth, worn, wear);
      earth = mix(earth, duff, footprint.smoothstep(0.02, 0.35).mul(growth.oneMinus()));
      earth = earth.mul(contact.oneMinus()).mul(footprint.smoothstep(0.1, 0.6).mul(0.4).oneMinus());
    }
    const variation = mix(1 - (config.ground.macroVariation ?? 0.2), 1.08, macro);
    const river = riverField(terrainSampler?.river).toVar();
    const riverBank = river.y.smoothstep(-1, 6).oneMinus();
    const bank = positionWorld.y.sub(config.water.position[1]).abs().smoothstep(0.2, 2.8).oneMinus()
      .max(positionWorld.y.sub(river.x).abs().smoothstep(0.2, 3.5).oneMinus().mul(riverBank));
    // The sea's waterline wets the rock too, up to a ragged splash height.
    // Water levels are global heights, so each term keeps to its own water:
    // the sea's to the coastal band (the lake bed also reaches sea level),
    // the lake's to the lake's extent.
    const seaLevel = config.water.sea?.enabled ? Number(config.water.sea.level) : null;
    const nearSea = seaLevel === null ? float(0)
      : positionWorld.x.sub(coastXNode(positionWorld.z, config.water.sea)).smoothstep(-260, -160);
    const nearLake = positionWorld.x.sub(config.water.position[0]).abs().lessThan(config.water.size / 2)
      .and(positionWorld.z.sub(config.water.position[2]).abs().lessThan(config.water.size / 2))
      .select(float(1), float(0));
    const waterlineHeight = detail.settings.rock.waterline.height;
    // Noise only where it can show: its terms are zero away from the water.
    const nearSeaLine = seaLevel === null ? float(0)
      : nearSea.mul(positionWorld.y.sub(seaLevel).abs().lessThan(waterlineHeight * 2).select(float(1), float(0)));
    const splash = gatedNoise(nearSeaLine.mul(detail.waterline), world.mul(0.09)).mul(0.7).add(0.5).mul(waterlineHeight);
    const seaBank = seaLevel === null ? float(0)
      : positionWorld.y.sub(seaLevel).sub(splash.mul(0.5)).abs().smoothstep(0.1, waterlineHeight).oneMinus().mul(nearSea);
    const wet = wetness.max(bank.mul(0.65)).max(seaBank.mul(detail.waterline).mul(0.85));
    // Weed and algae in the band right at the water: lake, river and sea.
    const waterEdge = (level) => positionWorld.y.sub(level).smoothstep(-0.35, 0.05)
      .mul(positionWorld.y.sub(level).smoothstep(0.1, 0.55).oneMinus());
    const algaeBand = waterEdge(float(config.water.position[1])).mul(nearLake).max(waterEdge(river.x).mul(riverBank))
      .max(seaLevel === null ? float(0) : waterEdge(float(seaLevel)).mul(nearSea)).toVar();
    const algae = algaeBand.mul(gatedNoise(algaeBand.mul(detail.waterline), world.mul(0.4)).smoothstep(-0.3, 0.3)).mul(detail.waterline);
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
      // Snow is built first so the rock can skip its detail under full cover.
      const snow = config.ground.snow?.enabled
        ? createSnowSurfaceNodes(config, snowDeformation, terrainSampler, getSnowTextures(config), blend,
          { concavity: curvature })
        : null;
      const rockSurface = createRockSurfaceNodes({
        config,
        colorTexture: groundColor,
        roughnessTexture: groundRoughness,
        macro,
        wet,
        riverBank,
        lakeBed,
        curvature,
        cover: snow?.mask ?? null,
      });
      // The ground's own height for height-blended transitions: its colour's
      // luminance (the textures are dark in linear light, so stretched).
      const groundHeight = luminance(material.colorNode).mul(2.5).clamp(0, 1).toVar();
      // Height blending only sharpens a transition where the textures that
      // drive it resolve. Far off they flatten under mipmapping, and a sharp
      // edge would just trace the mask's smooth contours as hard blobs, so the
      // blend fades back to the plain soft mask with distance. Near the
      // camera, noise at two scales roughens the edge beyond the texture's.
      const blendDistance = cameraPosition.distance(positionWorld);
      const blendReach = detail.settings.blend.distance;
      const nearBlend = blendDistance.smoothstep(blendReach[0], blendReach[1]).oneMinus();
      const blending = nearBlend.mul(detail.blend);
      const edgeNoise = gatedNoise(blending, world.mul(0.35).add(vec2(7.1, -3.3))).mul(0.7)
        .add(gatedNoise(blending, world.mul(1.3).add(vec2(-11.7, 5.9))).mul(0.35)).toVar();
      const blendSettings = {
        contrast: detail.settings.blend.contrast,
        width: detail.settings.blend.width,
        strength: detail.blend.mul(nearBlend),
        noise: edgeNoise,
      };
      // Paths keep their authored look: no height blending across them.
      const rockMask = heightBlend(rockSurface.mask, groundHeight, rockSurface.height,
        { ...blendSettings, strength: blendSettings.strength.mul(blend.oneMinus()) }).toVar();

      // Scree: gravel gathered in the hollows at the foot of cliffs and down
      // gullies, drawn as stones near the camera and as grit further off.
      if (curvature) {
        const rockConfig = resolveRockSurfaceConfig(config);
        const screeSettings = detail.settings.scree;
        // Talus: concave ground at the angle loose stone rests at (roughly 20
        // to 40 degrees), never flats, gully floors or paths.
        const hollow = curvature.div(detail.settings.rock.curvature.scale).smoothstep(0.08, 0.7);
        const talus = normalWorld.y.smoothstep(0.9, 0.96).oneMinus()
          .mul(normalWorld.y.smoothstep(0.7, 0.78));
        const screeMask = hollow.mul(talus).mul(blend.oneMinus())
          .mul(positionWorld.y.smoothstep(rockConfig.cliffAltitude.start * 0.5, rockConfig.cliffAltitude.start))
          .mul(rockMask.oneMinus()).mul(detail.scree).toVar();
        const screeDistance = cameraPosition.distance(positionWorld);
        const screeNear = screeDistance.smoothstep(screeSettings.distance * 0.6, screeSettings.distance).oneMinus();
        const screeStones = Fn(() => {
          const result = vec4(16, 0, 0, 0).toVar();
          If(screeMask.greaterThan(0.01).and(screeNear.greaterThan(0)), () => {
            result.assign(pebbleField(world.div(screeSettings.cell), float(0.8)));
          });
          return result;
        })();
        const screeEdge = fwidth(positionWorld.xz.div(screeSettings.cell)).length().mul(6).max(0.05);
        const stone = screeStones.x.smoothstep(float(1).sub(screeEdge), float(1).add(screeEdge)).oneMinus().mul(screeNear);
        const stoneColor = pebbleColor(screeStones.y, SCREE_PALETTE).mul(screeStones.x.oneMinus().max(0).sqrt().mul(0.4).add(0.7));
        const grit = color(SCREE_GRIT).mul(macro.mul(0.25).add(0.85));
        const screeColor = mix(grit, stoneColor, stone);
        material.colorNode = mix(material.colorNode, screeColor, screeMask);
        material.roughnessNode = mix(material.roughnessNode, float(0.95), screeMask);
      }
      // Up in snow country, exposed rock goes dark and cool, the way wet,
      // lichen-free alpine rock reads against snow.
      const alpineRock = config.ground.snow?.enabled && config.ground.snow.rockTint
        ? mix(rockSurface.color, rockSurface.color.mul(color(config.ground.snow.rockTint)),
          positionWorld.y.smoothstep(config.ground.snow.altitude.start, config.ground.snow.altitude.full))
        : rockSurface.color;
      const ice = createSnowIceNodes(config.ground.snow);
      const icedRock = ice ? mix(alpineRock, ice.color, ice.mask) : alpineRock;
      const rockColor = mix(icedRock, icedRock.mul(vec3(...ALGAE_TINT)), algae);
      const rockRoughness = ice ? mix(rockSurface.roughness, ice.roughness, ice.mask) : rockSurface.roughness;
      material.colorNode = mix(material.colorNode, rockColor, rockMask);
      material.roughnessNode = mix(material.roughnessNode, mix(rockRoughness, float(0.3), algae), rockMask);
      baseNormal = normalize(mix(baseNormal, rockSurface.normal, rockMask));
      material.normalNode = baseNormal;

      const terrainEmissive = (material.emissiveNode ?? vec3(0)).mul(rockMask.oneMinus());
      if (snow) {
        // Over rock, snow settles into the cracks and low grains first. On soil
        // and paths the snow's own coverage stands, so packed trails stay white.
        const onRock = heightBlend(snow.mask, rockSurface.height, float(0.55),
          { ...blendSettings, strength: blendSettings.strength.mul(blend.oneMinus()) });
        const snowMask = mix(snow.mask, onRock, rockMask).toVar();
        material.colorNode = mix(material.colorNode, snow.color, snowMask);
        material.roughnessNode = mix(material.roughnessNode, snow.roughness, snowMask);
        material.metalnessNode = mix(material.metalnessNode, float(0), snowMask);
        baseNormal = normalize(mix(baseNormal, snow.normal, snowMask));
        material.normalNode = baseNormal;
        material.emissiveNode = terrainEmissive.mul(snowMask.oneMinus()).add(snow.emissive.mul(snowMask.div(snow.mask.max(1e-3)).min(1)));
      } else {
        material.emissiveNode = terrainEmissive;
      }

      const sea = config.water.sea;
      const resolvedSea = sea?.enabled ? resolveCoastConfig(sea) : null;
      const coast = resolvedSea ? createCoastNodes(resolvedSea, coastClock, coastRain) : null;
      const sandParams = resolvedSea?.coast.sand;
      // The coast's inland edge wanders with noise, so sand meets grass along
      // a ragged line rather than one parallel to the shore.
      const rawCoastDistance = coast ? coast.distance(world).toVar() : float(0);
      const nearCoastEdge = rawCoastDistance.greaterThan(sandParams ? sandParams.inlandStart - 40 : 0)
        .select(float(1), float(0));
      const coastDistance = coast
        ? rawCoastDistance.add(gatedNoise(nearCoastEdge.mul(detail.coastEdge), world.mul(detail.settings.coastEdge.scale))
          .mul(detail.coastEdge))
        : float(0);
      const coastalBand = coast
        ? coastDistance.smoothstep(sandParams.inlandStart, sandParams.inlandEnd)
        : float(0);
      const cliffBand = coast
        ? coastDistance.smoothstep(resolvedSea.coast.terrain.inlandBlendStart, sandParams.inlandEnd)
        : float(0);
      const sandSurface = resolvedSea
        ? normalWorld.y.smoothstep(sandParams.slopeStart, sandParams.slopeEnd)
        : float(1);
      // Grass tufts hold on into the sand where the turf stands high.
      const coastal = heightBlend(coastalBand.mul(sandSurface), groundHeight, float(0.45), blendSettings);
      const coastalCliff = cliffBand.mul(sandSurface.oneMinus());

      if (resolvedSea) {
        const warmRock = rockColor.mul(color(sandParams.cliffRockTint));
        const coastalRock = mix(rockColor, warmRock, sandParams.cliffRockTintStrength);
        material.colorNode = mix(material.colorNode, coastalRock, coastalCliff);
        material.roughnessNode = mix(material.roughnessNode, rockRoughness, coastalCliff);
        baseNormal = normalize(mix(baseNormal, rockSurface.normal, coastalCliff));
        material.normalNode = baseNormal;
      }

      let sandGlint = vec3(0);
      let seabedLight = vec3(0);
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
        // The swash runs up the actual sand: its front is a height above still
        // water (CoastField swash*), so film and foam start where the sea meets
        // this ground instead of at a distance from the analytic coast curve.
        const heightAboveSea = positionWorld.y.sub(resolvedSea.level);
        const coverage = coast.swashCoverage(world, heightAboveSea);
        // Ground under the sea hands over to the sea surface by real depth, the
        // exact complement of the sea's opacity (WaterMaterial seaShoreOpacity).
        // Ground a metre under the surface is bed, not shore.
        const awash = heightAboveSea.smoothstep(-SUBMERGED_SWASH_DEPTH, -0.1);
        const groundHandoff = heightAboveSea.negate()
          .smoothstep(SEA_SHORE_OPACITY_START, SEA_SHORE_OPACITY_END).oneMinus().mul(awash);
        const memory = coast.swashMemory(world, heightAboveSea);
        const wetSand = coast.baseMoisture(world).mul(sandParams.baseMoistureStrength).mul(mix(sandParams.mesoWetMin, sandParams.mesoWetMax, meso))
          .add(memory.mul(sandParams.washMemoryStrength))
          .add(beachMoisture.mul(sandParams.rainMoistureStrength))
          .add(coverage.mul(sandParams.coverageWetness))
          .clamp(0, 1);
        const drySand = mix(color(sandParams.dryDark), color(sandParams.dryLight), sandMacro)
          .mul(sandRipples).mul(sandGrains).mul(mix(sandParams.mesoToneMin, sandParams.mesoToneMax, meso));
        const shoreSand = drySand.mul(wetSand.mul(sandParams.wetDarkening).oneMinus());
        // The sea floor past the swash is sand seen through clear water. The
        // water above does the tinting, so the bed keeps most of dry sand's
        // light instead of reading as soaked shore sand; reef patches of
        // weed-grown rock break it up across the shelf.
        const seabed = resolvedSea.coast.seabed;
        const bedDepth = heightAboveSea.negate();
        const bed = bedDepth.smoothstep(seabed.start, seabed.full);
        const bedSand = mix(drySand, color(seabed.color).mul(sandRipples), seabed.colorWeight)
          .mul(1 - seabed.darkening);
        const reefBand = bedDepth.smoothstep(seabed.reefShallow, seabed.reefFull)
          .mul(bedDepth.smoothstep(seabed.reefFadeStart, seabed.reefFadeEnd).oneMinus());
        // x: patch coverage, y: weed and rock mottling inside a patch.
        const reefField = Fn(() => {
          const value = vec2(0).toVar();
          If(reefBand.greaterThan(0), () => {
            const p = world.mul(seabed.reefFrequency);
            const warp = vec2(
              noise2(p.mul(2.1).add(vec2(7.1, 2.3))),
              noise2(p.mul(2.1).add(vec2(3.7, 19.2))),
            ).mul(seabed.reefWarp);
            const shape = noise2(p.add(warp))
              .add(noise2(p.mul(2.6).add(warp.mul(1.7)).add(11.3)).mul(0.45))
              .add(noise2(p.mul(7.3).add(5.9)).mul(0.2));
            const mottle = noise2(world.mul(1.7)).mul(0.55).add(noise2(world.mul(5.1)).mul(0.3)).add(0.5);
            value.assign(vec2(shape.smoothstep(seabed.reefThreshold, seabed.reefThreshold + seabed.reefEdge), mottle));
          });
          return value;
        })().toVar();
        const reef = reefField.x.mul(reefBand);
        const reefColor = mix(color(seabed.reefColor), color(seabed.reefRockColor), reefField.y.smoothstep(0.3, 0.8))
          .mul(reefField.y.mul(0.5).add(0.75));
        const bedColor = mix(bedSand, reefColor, reef).toVar();
        const saturatedSand = mix(shoreSand, bedColor, bed);
        // Sunlight focused by the waves above: a moving network of bright lines
        // on the bed, from the shallows down past the reefs.
        const causticFade = bedDepth.smoothstep(seabed.causticShallow, seabed.causticShallow + 0.4)
          .mul(bedDepth.smoothstep(seabed.causticDepth * 0.35, seabed.causticDepth).oneMinus())
          .mul(cameraPosition.distance(positionWorld)
            .smoothstep(seabed.causticDistance * 0.5, seabed.causticDistance).oneMinus())
          .toVar();
        const seaCaustic = Fn(() => {
          const value = float(0).toVar();
          If(causticFade.greaterThan(0), () => {
            const p = world.mul(seabed.causticScale);
            const a = noise2(p.add(vec2(time.mul(0.23), time.mul(0.11))));
            const b = noise2(p.mul(1.41).add(vec2(time.mul(-0.17), time.mul(0.2))).add(4.7));
            value.assign(float(1).sub(a.add(b).abs().mul(2.4)).max(0).pow(5));
          });
          return value;
        })();
        seabedLight = bedColor.mul(foliageLight.color).mul(foliageLight.strength)
          .mul(seaCaustic.mul(causticFade).mul(seabed.causticStrength));
        const film = coverage.mul(groundHandoff);
        const foam = coast.swashFoam(world, heightAboveSea).mul(groundHandoff).mul(sandParams.foamStrength);
        // Sand under the swash sheet is seen through clear water, like the bed,
        // not soaked and dark, and the water tints it aqua by absorbing red. A
        // flat blend toward a tint read as a grey strip along the flat foreshore.
        const filmBase = mix(saturatedSand, bedColor, film.mul(sandParams.filmClarity));
        const filmColor = mix(filmBase, filmBase.mul(color(sandParams.filmTint)), film.mul(sandParams.filmTintStrength));
        const foamedColor = mix(filmColor, color(sandParams.foamColor), foam.clamp(0, 1));
        // Dry sand streaming across the beach in the wind (AmbientEffectsSystem
        // sets its strength): lighter sand in the albedo, so it is lit, shaded
        // and shadowed like the beach it crosses. Short streaks, so they do
        // not kink visibly over the beach's facets.
        const drift = blownStreaks({
          direction: ambientUniforms.windDirection,
          travel: ambientUniforms.sandStreakTravel,
          amount: ambientUniforms.sandStreaks,
          length: 2.6,
          width: 0.3,
          patch: 26,
          reach: 80,
        }).mul(wetSand.oneMinus().pow(2)).mul(film.oneMinus());
        const beachColor = mix(foamedColor, color(sandParams.dryLight).mul(1.15), drift.mul(0.7).clamp(0, 1));
        // Footprints come from the same deformation field the snow reads. The
        // print darkens the sand and the kicked berm dries lighter.
        const prints = createDeformationNodes(snowDeformation, world);
        const footprintColor = beachColor
          .mul(prints.depression.mul(sandParams.footprintDarkening).oneMinus())
          .add(prints.berm.mul(sandParams.footprintBermLighten));

        // Pebbles: rounded stones drawn in the sand, thick along the strand
        // line the waves leave and in scattered patches, wet and glossy where
        // the swash reaches. Near the camera only; past that they are sand.
        const pebbles = detail.settings.pebbles;
        const pebbleNear = cameraPosition.distance(positionWorld)
          .smoothstep(pebbles.distance * 0.6, pebbles.distance).oneMinus();
        const strand = heightAboveSea.smoothstep(pebbles.strandHeight[0], pebbles.strandHeight[0] + 0.35)
          .mul(heightAboveSea.smoothstep(pebbles.strandHeight[1] - 0.8, pebbles.strandHeight[1]).oneMinus());
        const pebblePatch = sandMacro.smoothstep(0.55, 0.85).mul(meso.smoothstep(0.3, 0.7));
        // Never under the water, the wash or its foam: the waves run over the
        // sand, and a stone drawn on top of the swash would float on it.
        const washed = film.max(foam).max(coverage).smoothstep(0.01, 0.15);
        const pebbleDensity = strand.mul(pebbles.strand).max(pebblePatch.mul(pebbles.density))
          .mul(heightAboveSea.smoothstep(0.1, 0.4)).mul(washed.oneMinus()).mul(coastalBand).clamp(0, 0.9).toVar();
        const stones = Fn(() => {
          const result = vec4(16, 0, 0, 0).toVar();
          If(detail.pebbles.greaterThan(0).and(pebbleNear.greaterThan(0)).and(pebbleDensity.greaterThan(0.01)), () => {
            result.assign(pebbleField(world.div(pebbles.cell), pebbleDensity));
          });
          return result;
        })().toVar();
        // Anti-aliased rim, from the pixel's size in cells (outside the branch).
        const pebbleEdge = fwidth(positionWorld.xz.div(pebbles.cell)).length().mul(6).max(0.04);
        const pebble = stones.x.smoothstep(float(1).sub(pebbleEdge), float(1).add(pebbleEdge)).oneMinus()
          .mul(pebbleNear).mul(detail.pebbles).toVar();
        const crown = stones.x.oneMinus().max(0).sqrt();
        // Sand darkens in a thin ring where it meets a stone.
        const contact = stones.x.sqrt().smoothstep(1, 1.3).oneMinus().mul(pebble.oneMinus()).mul(pebbleNear)
          .mul(detail.pebbles);
        const stoneColor = pebbleColor(stones.y, BEACH_PEBBLE_PALETTE).mul(crown.mul(0.35).add(0.72))
          .mul(wetSand.max(film).mul(0.45).oneMinus());
        const printedColor = mix(footprintColor.mul(contact.mul(0.3).oneMinus()), stoneColor, pebble);
        material.colorNode = mix(material.colorNode, printedColor, coastal);
        const sandRoughness = mix(
          sandParams.dryRoughness,
          sandParams.wetRoughness,
          wetSand.pow(2),
        );
        const filmRoughness = mix(sandRoughness, sandParams.filmRoughness, film);
        // Dry stones are matte; wet ones glisten.
        const stoneRoughness = mix(float(0.72), float(0.22), wetSand.max(film));
        material.roughnessNode = mix(
          material.roughnessNode,
          mix(mix(filmRoughness, sandParams.foamRoughness, foam), stoneRoughness, pebble),
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
        const printSlope = vec3(prints.gradient.x.negate(), 0, prints.gradient.y.negate())
          .mul(sandParams.footprintNormalStrength);
        const stoneSlope = vec3(stones.z, 0, stones.w).mul(pebble).mul(0.9);
        const sandWorldNormal = normalize(normalWorld.add(sandSlope.mul(pebble.oneMinus())).add(printSlope).add(stoneSlope));
        const sandNormal = normalize(cameraViewMatrix.mul(vec4(sandWorldNormal, 0)).xyz);
        baseNormal = normalize(mix(baseNormal, sandNormal, coastal));
        material.normalNode = baseNormal;
        // Dry quartz sand sparkles the way snow crystals do; wet sand and the
        // water film stay matte.
        sandGlint = foliageLight.color.mul(foliageLight.strength).mul(snowGlints({
          worldXZ: world,
          normal: sandWorldNormal,
          view: normalize(cameraPosition.sub(positionWorld)),
          light: foliageLight.direction,
          footprint: fwidth(world).length().mul(0.5).max(1e-4),
          intensity: sandParams.glintStrength,
          grazing: sandParams.glintGrazing,
          worldScale: sandParams.glintWorldScale,
        })).mul(wetSand.oneMinus()).mul(film.oneMinus()).mul(coastal).mul(0.55);
      }
      const coastalSurface = coastal.max(coastalCliff);
      material.emissiveNode = (material.emissiveNode ?? vec3(0)).mul(coastalSurface.oneMinus())
        .add(sandGlint).add(seabedLight.mul(coastal));

      const inlandY = river.y.lessThan(0).select(river.x, float(config.water.position[1]));
      const surfaceY = coastalBand.greaterThan(0.5).select(float(resolvedSea?.level ?? -24), inlandY);
      const depth = surfaceY.sub(positionWorld.y);
      // Lakes and rivers; the sea floor has its own caustics (seabedLight).
      const submerged = depth.smoothstep(0.02, 0.3).mul(depth.smoothstep(1, 5).oneMinus())
        .mul(coastalBand.oneMinus());
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
    textures: [grassColor, groundColor, groundNormal, groundRoughness],
    setVegetationField: (fieldTexture) => terrainSampler?.paths?.writeVegetationExclusion?.(fieldTexture) ?? false,
    setContactShade: (sources) => terrainSampler?.paths?.writeContactShade?.(sources) ?? false,
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
