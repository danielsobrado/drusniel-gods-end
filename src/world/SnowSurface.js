import {
  Fn,
  If,
  cameraPosition,
  cameraViewMatrix,
  color,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { foliageLight } from '../rendering/CinematicLighting.js';
import { noise2, snowFineRelief } from './snowNoiseNodes.js';
import { snowGlints, snowSubsurface } from './snowShadingNodes.js';
import { SNOW_SLOPE_PATCH } from './SnowDeformationField.js';

// Linear-light means of the Snow007C colour, roughness and displacement maps,
// so the detail only varies the surface around its configured tone.
const DETAIL_COLOR_MEAN = [0.629, 0.737, 0.849];
const DETAIL_ROUGHNESS_MEAN = 0.714;
const DETAIL_HEIGHT_MEAN = 0.274;
const DETAIL_OCCLUSION_MEAN = 0.944;
// Cavity change per unit of displacement below or above the mean; the map's
// standard deviation is 0.1, so one deviation is a quarter.
const HOLLOW_CONTRAST = 2.5;
const DEFORMATION_NEUTRAL = 128 / 255;
// Camera distances (world units) over which snow switches from the mesh normal
// to the heightfield normal for its slope mask and colour weights.
const HEIGHTFIELD_NORMAL_BLEND_START = 60;
const HEIGHTFIELD_NORMAL_BLEND_END = 140;
// Brightness of a footprint's interior relative to the snow shadow colour.
const FOOTPRINT_INTERIOR_SHADE = 0.68;
// Below this coverage the procedural relief is skipped entirely.
const MASK_EPSILON = 0.002;
// Snowflow resolves sub-pixel relief with TAA, which is off by default here,
// so each relief layer fades out at a proportionally smaller pixel footprint.
const RELIEF_FILTER_SCALE = 1.6;
// Sastrugi and ripples are carved into lying snow; on a wall a planar
// projection would only stretch them into vertical streaks. Normal Y range.
const RELIEF_FLAT_START = 0.62;
const RELIEF_FLAT_END = 0.88;
// Slope (1 - normal Y) over which the detail maps go triplanar.
const TRIPLANAR_START = 0.2;
const TRIPLANAR_END = 0.55;
// Relief height, in Snowflow metres, at which the crest/trough tone saturates.
const RELIEF_TONE_HEIGHT = 0.06;
// Light reaching into a hollow of snow has scattered through snow on the way.
const CAVE_TINT = [0.55, 0.72, 1];
// Snowflow uses 0.95; its ambient is less blue than the sky light here.
const CAVE_TINT_STRENGTH = 0.7;
const FLAT_NORMAL = [0, 0, 1];

// Snowflow's three tiling scales of the detail map, in cycles per Snowflow
// metre, each faded out between two pixel footprints (Snowflow metres).
const DETAIL_LAYERS = Object.freeze([
  { frequency: 7.5, fadeStart: 0.004, fadeEnd: 0.02, weight: 1 },
  { frequency: 1.7, fadeStart: 0.02, fadeEnd: 0.12, weight: 0.85 },
  { frequency: 0.31, fadeStart: 0.1, fadeEnd: 0.7, weight: 0.6 },
]);
// Crevice occlusion from the packed map: the grain scale close up, and the
// broad scale, where the crust pattern is still legible, further out.
const CAVITY_LAYERS = Object.freeze([
  { frequency: 1.7, fadeStart: 0.02, fadeEnd: 0.25, weight: 1 },
  { frequency: 0.31, fadeStart: 0.12, fadeEnd: 1.1, weight: 0.8 },
]);

function positiveNumber(value, name) {
  const number = Number(value);
  if (!(number > 0) || !Number.isFinite(number)) throw new Error(`${name} must be a positive finite number.`);
  return number;
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number.`);
  return number;
}

function interval(value, name) {
  if (!value || typeof value !== 'object') throw new Error(`${name} configuration is required.`);
  const start = finiteNumber(value.start, `${name}.start`);
  const full = finiteNumber(value.full, `${name}.full`);
  if (!(full > start)) throw new Error(`${name}.full must be greater than ${name}.start.`);
  return { start, full };
}

function optionalNumber(value, fallback, name) {
  return value === undefined ? fallback : finiteNumber(value, name);
}

function deformationAppearance(config) {
  if (config?.enabled === false) {
    return { normalStrength: 0, darkenStrength: 0, bermLighten: 0 };
  }
  return {
    normalStrength: finiteNumber(config?.normalStrength, 'ground.snow.deformation.normalStrength'),
    darkenStrength: finiteNumber(config?.darkenStrength, 'ground.snow.deformation.darkenStrength'),
    bermLighten: finiteNumber(config?.bermLighten, 'ground.snow.deformation.bermLighten'),
  };
}

export function resolveSnowConfig(config) {
  if (!config) throw new Error('ground.snow configuration is required.');
  const angle = finiteNumber(config.wind.angleDegrees, 'ground.snow.wind.angleDegrees') * Math.PI / 180;
  return {
    enabled: config.enabled !== false,
    altitude: interval(config.altitude, 'ground.snow.altitude'),
    slope: {
      ...interval(config.slope, 'ground.snow.slope'),
      noise: optionalNumber(config.slope?.noise, 0, 'ground.snow.slope.noise'),
    },
    // Snow on a walked route is packed: darker, bluer, smoother and less grainy.
    path: {
      compaction: optionalNumber(config.path?.compaction, 0, 'ground.snow.path.compaction'),
      color: config.path?.color ?? config.colors?.shadow,
    },
    wind: {
      angle,
      cos: Math.cos(angle),
      sin: Math.sin(angle),
      driftFrequency: positiveNumber(config.wind.driftFrequency, 'ground.snow.wind.driftFrequency'),
      crossFrequency: positiveNumber(config.wind.crossFrequency, 'ground.snow.wind.crossFrequency'),
      exposureFrequency: positiveNumber(config.wind.exposureFrequency, 'ground.snow.wind.exposureFrequency'),
      exposureCrossFrequency: positiveNumber(config.wind.exposureCrossFrequency, 'ground.snow.wind.exposureCrossFrequency'),
      warp: finiteNumber(config.wind.warp, 'ground.snow.wind.warp'),
      driftHeight: finiteNumber(config.wind.driftHeight, 'ground.snow.wind.driftHeight'),
      scourStrength: finiteNumber(config.wind.scourStrength, 'ground.snow.wind.scourStrength'),
    },
    relief: {
      sastrugi: finiteNumber(config.relief.sastrugi, 'ground.snow.relief.sastrugi'),
      ripples: finiteNumber(config.relief.ripples, 'ground.snow.relief.ripples'),
      grain: finiteNumber(config.relief.grain, 'ground.snow.relief.grain'),
      windward: finiteNumber(config.relief.windward, 'ground.snow.relief.windward'),
      toneContrast: finiteNumber(config.relief.toneContrast, 'ground.snow.relief.toneContrast'),
    },
    colors: config.colors,
    roughness: {
      base: finiteNumber(config.roughness.base, 'ground.snow.roughness.base'),
      compressed: finiteNumber(config.roughness.compressed, 'ground.snow.roughness.compressed'),
      berm: finiteNumber(config.roughness.berm, 'ground.snow.roughness.berm'),
      variation: finiteNumber(config.roughness.variation, 'ground.snow.roughness.variation'),
    },
    lighting: {
      sssStrength: finiteNumber(config.lighting.sssStrength, 'ground.snow.lighting.sssStrength'),
      sssRadius: positiveNumber(config.lighting.sssRadius, 'ground.snow.lighting.sssRadius'),
      glintStrength: finiteNumber(config.lighting.glintStrength, 'ground.snow.lighting.glintStrength'),
      glintGrazing: finiteNumber(config.lighting.glintGrazing, 'ground.snow.lighting.glintGrazing'),
    },
    detail: {
      worldScale: positiveNumber(config.detail.worldScale, 'ground.snow.detail.worldScale'),
      strength: finiteNumber(config.detail.strength, 'ground.snow.detail.strength'),
      cavity: finiteNumber(config.detail.cavity, 'ground.snow.detail.cavity'),
      colorVariation: finiteNumber(config.detail.colorVariation, 'ground.snow.detail.colorVariation'),
      roughnessVariation: finiteNumber(config.detail.roughnessVariation, 'ground.snow.detail.roughnessVariation'),
    },
    deformation: deformationAppearance(config.deformation),
  };
}

function windCoordinates(world, snow) {
  const along = world.x.mul(snow.wind.cos).add(world.y.mul(snow.wind.sin));
  const across = world.x.mul(-snow.wind.sin).add(world.y.mul(snow.wind.cos));
  return { along, across };
}

// Reads the player-following footprint field at a world XZ position. Shared by
// snow and beach sand. Returns depression and berm in [0, 1] and the signed
// world-space slope of the print, all zero outside the field's window.
export function createDeformationNodes(deformationField, world) {
  let deform = vec4(0, 0, DEFORMATION_NEUTRAL, DEFORMATION_NEUTRAL);
  let inside = float(0);
  if (deformationField?.config?.enabled) {
    const center = uniform(deformationField.center);
    const deformationUv = world.sub(center).div(deformationField.config.worldSize).add(0.5);
    const insideX = step(float(0), deformationUv.x).mul(step(deformationUv.x, float(1)));
    const insideY = step(float(0), deformationUv.y).mul(step(deformationUv.y, float(1)));
    inside = insideX.mul(insideY);
    deform = texture(deformationField.texture, deformationUv.clamp(0, 1));
  }
  return {
    depression: deform.x.mul(inside),
    berm: deform.y.mul(inside),
    gradient: vec2(deform.z.sub(DEFORMATION_NEUTRAL), deform.w.sub(DEFORMATION_NEUTRAL)).mul(2).mul(inside),
  };
}

function unpackNormal(sample) {
  const xy = sample.xy.mul(2).sub(1);
  return vec3(xy, xy.dot(xy).oneMinus().max(0).sqrt());
}

// Reoriented normal mapping: folds a tangent-space detail normal onto a base
// one without losing the base's tilt, which a plain add-and-normalise does.
function blendReoriented(base, detail) {
  const t = base.add(vec3(0, 0, 1));
  const u = detail.mul(vec3(-1, -1, 1));
  return normalize(t.mul(dot(t, u)).sub(u.mul(t.z)));
}

// Water ice on faces too steep to hold snow: patches of glazed rock and
// frozen seepage streaking down the fall line, only inside the snow band.
// Returns null when `ground.snow.ice` is not configured.
export function createSnowIceNodes(snowConfig) {
  const ice = snowConfig?.ice;
  if (!snowConfig?.enabled || !ice) return null;
  const altitude = interval(snowConfig.altitude, 'ground.snow.altitude');
  const steepness = interval(ice.steepness, 'ground.snow.ice.steepness');
  const coverage = finiteNumber(ice.coverage, 'ground.snow.ice.coverage');
  const roughness = finiteNumber(ice.roughness, 'ground.snow.ice.roughness');
  const band = positionWorld.y.smoothstep(altitude.start, altitude.full);
  const steep = normalWorld.y.abs().smoothstep(steepness.start, steepness.full).oneMinus();
  // Height is folded into the patch coordinates so a wall varies down its face.
  const patch = noise2(vec2(
    positionWorld.x.mul(0.031).add(positionWorld.y.mul(0.017)),
    positionWorld.z.mul(0.031).sub(positionWorld.y.mul(0.013)),
  )).smoothstep(-0.05, 0.3);
  const streak = noise2(vec2(positionWorld.x.add(positionWorld.z).mul(0.09), positionWorld.y.mul(0.011)))
    .smoothstep(0.15, 0.4);
  const mask = band.mul(steep).mul(patch.max(streak.mul(0.8))).mul(coverage).clamp(0, 1);
  // Thick ice goes deeper blue; thin glaze shows grey rock through it.
  const thickness = noise2(positionWorld.xz.mul(0.13).add(positionWorld.y.mul(0.05))).mul(0.5).add(0.5);
  const iceColor = mix(color(ice.thinColor ?? ice.color), color(ice.color), thickness);
  return { mask, color: iceColor, roughness: float(roughness) };
}

// The GPU side of snowSlopePatchCpu.
function snowSlopePatch(world) {
  const [ax, az, aw, bz, bx, bw] = SNOW_SLOPE_PATCH.broad;
  const [fx, fz, fw, fa] = SNOW_SLOPE_PATCH.fine;
  const broad = sin(world.x.mul(ax).add(sin(world.y.mul(az)).mul(aw)))
    .mul(sin(world.y.mul(bz).add(sin(world.x.mul(bx)).mul(bw))));
  const fine = sin(world.x.mul(fx).sub(world.y.mul(fz)).add(sin(world.x.mul(fw)).mul(fa)));
  return broad.add(fine.mul(0.5)).div(1.5);
}

export function createSnowSurfaceNodes(config, deformationField = null, terrainSampler = null, textures = null, pathMask = null) {
  const snow = resolveSnowConfig(config.ground.snow);
  const world = positionWorld.xz;
  const { along, across } = windCoordinates(world, snow);
  const worldScale = snow.detail.worldScale;

  // The snow slope mask and shadow/base colour weight blend from the mesh normal
  // near the camera to the smooth heightfield normal far away. Far off, the
  // mesh normal's regular 4 m triangulation aliases into diagonal beat bands;
  // up close the mesh resolves steep wall bases more finely than the 1.56 m
  // heightfield, whose normals would step the snow edge. Outside the
  // heightfield (the backdrop mesh) the mesh normal is kept.
  let surfaceUp = normalWorld.y;
  let landformSlope = normalWorld.xz;
  const normalTexture = terrainSampler?.normalTexture;
  if (normalTexture && terrainSampler.size?.x > 0 && terrainSampler.size?.z > 0) {
    const min = terrainSampler.bounds.min;
    const heightfieldUv = world.sub(vec2(min.x, min.z)).div(vec2(terrainSampler.size.x, terrainSampler.size.z));
    const inside = heightfieldUv.x.greaterThanEqual(0).and(heightfieldUv.x.lessThanEqual(1))
      .and(heightfieldUv.y.greaterThanEqual(0)).and(heightfieldUv.y.lessThanEqual(1));
    const heightfieldNormal = texture(normalTexture, heightfieldUv.clamp(0, 1)).xyz.mul(2).sub(1).normalize().toVar();
    const farBlend = cameraPosition.distance(positionWorld)
      .smoothstep(HEIGHTFIELD_NORMAL_BLEND_START, HEIGHTFIELD_NORMAL_BLEND_END);
    surfaceUp = mix(normalWorld.y, inside.select(heightfieldNormal.y, normalWorld.y), farBlend).toVar();
    landformSlope = inside.select(heightfieldNormal.xz, normalWorld.xz);
  }

  const driftPhase = along.mul(snow.wind.driftFrequency)
    .add(sin(across.mul(snow.wind.crossFrequency)).mul(snow.wind.warp));
  const drift = sin(driftPhase).mul(0.5).add(0.5);
  const exposure = sin(along.mul(snow.wind.exposureFrequency)
    .sub(across.mul(snow.wind.exposureCrossFrequency))).mul(0.5).add(0.5);
  const effectiveHeight = positionWorld.y
    .add(drift.mul(snow.wind.driftHeight))
    .sub(exposure.mul(snow.wind.scourStrength));
  const altitude = smoothstep(snow.altitude.start, snow.altitude.full, effectiveHeight);
  const slopeShift = snow.slope.noise ? snowSlopePatch(world).mul(snow.slope.noise) : float(0);
  const slope = smoothstep(slopeShift.add(snow.slope.start), slopeShift.add(snow.slope.full), surfaceUp.abs());
  const mask = altitude.mul(slope).clamp(0, 1).toVar();

  // World-space size of this pixel, as Snowflow's snow material takes it: every
  // detail fade below keys off it, so detail only exists where it resolves.
  const ddx = dFdx(positionWorld).toVar();
  const ddy = dFdy(positionWorld).toVar();
  const footprint = vec2(ddx.xz.length(), ddy.xz.length()).length().max(1e-4).toVar();
  const reliefFootprint = footprint.mul(RELIEF_FILTER_SCALE / worldScale);
  const flatness = normalWorld.y.smoothstep(RELIEF_FLAT_START, RELIEF_FLAT_END);

  // Wind scours faces turned into it and the crests of the large exposure
  // pattern into hard sastrugi; lee slopes and hollows keep their ripples.
  const windward = dot(landformSlope, vec2(snow.wind.cos, snow.wind.sin)).negate();
  const reliefExposure = exposure.sub(0.5).mul(0.6).add(0.5)
    .add(windward.mul(snow.relief.windward * 2.5))
    .clamp(0, 1)
    .toVar();

  // Snowflow's analytic fine layer, evaluated in Snowflow metres. It is the
  // costliest part of the ground shader, so pixels without snow skip it. The
  // branch condition reads the footprint and exposure, so their derivative and
  // texture terms are emitted ahead of the branch, in uniform control flow.
  const relief = Fn(() => {
    const result = vec3(0).toVar();
    If(mask.greaterThan(MASK_EPSILON).and(footprint.greaterThan(0)).and(reliefExposure.greaterThanEqual(0)), () => {
      result.assign(snowFineRelief(
        world.div(worldScale),
        float(snow.wind.angle),
        reliefExposure,
        reliefFootprint,
        vec3(snow.relief.sastrugi, snow.relief.ripples, snow.relief.grain).mul(flatness),
      ));
    });
    return result;
  })().toVar();

  const deformation = createDeformationNodes(deformationField, world);
  const depression = deformation.depression.mul(mask).toVar();
  const berm = deformation.berm.mul(mask).toVar();
  const packed = pathMask && snow.path.compaction > 0
    ? pathMask.clamp(0, 1).mul(snow.path.compaction).mul(mask)
    : float(0);
  const compressed = depression.max(berm.mul(0.2)).max(packed).clamp(0, 1).toVar();
  const deformGradient = deformation.gradient.mul(snow.deformation.normalStrength);

  // Landform, relief and carved snow are all heightfield slopes, so they add as
  // slopes before becoming a normal. Only the detail map is a tangent-space
  // normal, and it is folded in last.
  const reliefSlope = relief.yz.add(deformGradient).mul(mask);
  const shapedNormal = normalize(normalWorld.add(vec3(reliefSlope.x.negate(), 0, reliefSlope.y.negate()))).toVar();

  let snowWorldNormal = shapedNormal;
  let cavity = float(1);
  let colorVariation = vec3(1);
  let roughnessDetail = float(0);
  if (textures) {
    // On steep snow a planar projection stretches the grain down the fall
    // line, so the coarser layers go triplanar there, as in Snowflow's
    // detailNormal. The side projections only run on steep pixels, with
    // explicit gradients taken in uniform control flow above; the branch
    // condition names them so they are emitted ahead of it.
    const steep = shapedNormal.y.oneMinus().smoothstep(TRIPLANAR_START, TRIPLANAR_END).toVar();
    const sideWeights = shapedNormal.abs().pow(4).toVar();
    const detailNormal = (frequency, triplanar) => Fn(() => {
      const scale = frequency / worldScale;
      const sample = vec3(...FLAT_NORMAL).toVar();
      sample.assign(unpackNormal(texture(textures.normal, world.mul(scale))));
      if (!triplanar) return sample;
      If(steep.greaterThan(0.01).and(ddx.x.equal(ddx.x)).and(ddy.x.equal(ddy.x)), () => {
        const side = (projected, dx, dy) => unpackNormal(
          texture(textures.normal, projected.mul(scale)).grad(dx.mul(scale), dy.mul(scale)),
        );
        const facingZ = side(positionWorld.xy, ddx.xy, ddy.xy);
        const facingX = side(positionWorld.zy, ddx.zy, ddy.zy);
        const total = sideWeights.x.add(sideWeights.y).add(sideWeights.z).max(1e-4);
        const blended = facingZ.mul(sideWeights.z).add(facingX.mul(sideWeights.x)).add(sample.mul(sideWeights.y))
          .div(total);
        sample.assign(normalize(mix(sample, blended, steep)));
      });
      return sample;
    })();

    // Three tiling scales of the Snow007C normal map, each cross-faded out by
    // footprint and blended with reoriented normal mapping, as Snowflow's
    // snow material does. Trodden snow keeps less of its grain.
    const flat = vec3(...FLAT_NORMAL);
    let detail = flat;
    DETAIL_LAYERS.forEach((layer, index) => {
      const fade = smoothstep(layer.fadeStart * worldScale, layer.fadeEnd * worldScale, footprint).oneMinus()
        .mul(layer.weight);
      detail = blendReoriented(detail, mix(flat, detailNormal(layer.frequency, index > 0), fade));
    });
    // The tangent frame follows the planar projection (u along X, v along Z),
    // so the relief lights up the same way as the crevices baked into the maps.
    const tangent = normalize(vec3(1, 0, 0).sub(shapedNormal.mul(shapedNormal.x)).add(vec3(0, 0, 1e-5)));
    const bitangent = normalize(cross(tangent, shapedNormal));
    const detailStrength = mix(float(1), float(0.45), compressed).mul(snow.detail.strength).mul(mask);
    snowWorldNormal = normalize(shapedNormal.add(
      tangent.mul(detail.x).add(bitangent.mul(detail.y)).mul(detailStrength),
    )).toVar();

    // Crevice occlusion from the ambient-occlusion and displacement channels,
    // normalised to a mean of one: hollows darken and crests lift, but the
    // field as a whole does not get darker toward the camera as layers fade in.
    // Planar only, so it steps back on steep snow rather than streaking.
    const planarOnly = steep.oneMinus();
    let occlusion = float(1);
    for (const layer of CAVITY_LAYERS) {
      const packed = texture(textures.packed, world.mul(layer.frequency / worldScale));
      const hollow = packed.b.sub(DETAIL_HEIGHT_MEAN).mul(HOLLOW_CONTRAST).add(1).clamp(0.25, 1.2);
      const layerCavity = packed.r.div(DETAIL_OCCLUSION_MEAN).mul(hollow);
      const fade = smoothstep(layer.fadeStart * worldScale, layer.fadeEnd * worldScale, footprint).oneMinus()
        .mul(layer.weight).mul(planarOnly);
      occlusion = occlusion.mul(mix(float(1), layerCavity, fade));
    }
    cavity = mix(float(1), occlusion, snow.detail.cavity).toVar();

    const grain = texture(textures.packed, world.mul(DETAIL_LAYERS[1].frequency / worldScale));
    const midFade = smoothstep(DETAIL_LAYERS[1].fadeStart * worldScale, DETAIL_LAYERS[1].fadeEnd * worldScale, footprint)
      .oneMinus();
    roughnessDetail = grain.g.sub(DETAIL_ROUGHNESS_MEAN).mul(snow.detail.roughnessVariation).mul(midFade);

    const broadFade = smoothstep(DETAIL_LAYERS[2].fadeStart * worldScale, DETAIL_LAYERS[2].fadeEnd * worldScale, footprint)
      .oneMinus();
    const broadColor = texture(textures.color, world.mul(DETAIL_LAYERS[2].frequency / worldScale)).rgb;
    colorVariation = mix(
      vec3(1),
      broadColor.div(vec3(...DETAIL_COLOR_MEAN)).clamp(0.75, 1.25),
      broadFade.mul(planarOnly).mul(snow.detail.colorVariation),
    );
  }
  const snowViewNormal = normalize(cameraViewMatrix.mul(vec4(snowWorldNormal, 0)).xyz).toVar();

  // Snow albedo sits in a narrow, high, slightly blue band; the lighting makes
  // the warm/cool split. Faces turned away from the sky take the shadow tone,
  // relief crests brighten and troughs darken a little, and the broad drift
  // pattern keeps a wide field from reading as one flat sheet.
  const driftTone = mix(
    1 - Number(snow.colors.driftVariation),
    1 + Number(snow.colors.driftVariation),
    drift,
  );
  const reliefTone = relief.x.div(RELIEF_TONE_HEIGHT).clamp(-1, 1).mul(snow.relief.toneContrast).add(1);
  const upward = surfaceUp.max(0).smoothstep(0.35, 0.95);
  const surfaceColor = mix(
    mix(color(snow.colors.shadow), color(snow.colors.base), upward).mul(driftTone).mul(reliefTone),
    color(snow.path.color),
    packed,
  );
  // Footprints read through a cool, sky-lit interior. A plain multiply on
  // bright snow sits in the tonemap shoulder and all but disappears.
  const baseColor = mix(surfaceColor, color(snow.colors.shadow).mul(FOOTPRINT_INTERIOR_SHADE),
    depression.mul(snow.deformation.darkenStrength).clamp(0, 1));
  const bermColor = mix(baseColor, color(snow.colors.sun), berm.mul(snow.deformation.bermLighten).clamp(0, 1));
  // Occlusion scales the colour and goes blue as it darkens. A neutral
  // darkening under a warm sun reads as tan, not as shaded snow.
  const occlusion = cavity.mul(depression.mul(1.9).clamp(0, 1).mul(0.38).oneMinus());
  const caveTint = mix(vec3(1), vec3(...CAVE_TINT), occlusion.oneMinus().max(0).mul(CAVE_TINT_STRENGTH));
  const snowColor = bermColor.mul(colorVariation).mul(occlusion).mul(caveTint).toVar();

  const viewDirection = normalize(cameraPosition.sub(positionWorld));
  const sunRadiance = foliageLight.color.mul(foliageLight.strength);
  const glint = snowGlints({
    worldXZ: world,
    normal: snowWorldNormal,
    view: viewDirection,
    light: foliageLight.direction,
    footprint,
    intensity: snow.lighting.glintStrength,
    grazing: snow.lighting.glintGrazing,
    worldScale,
  }).mul(mask);

  // Trodden snow is denser and transmits less; open drifts glow when backlit.
  const subsurface = snowSubsurface({
    normal: snowWorldNormal,
    light: foliageLight.direction,
    view: viewDirection,
    lightColor: sunRadiance,
    thickness: mix(float(1), float(0.35), compressed),
    strength: snow.lighting.sssStrength,
    radius: snow.lighting.sssRadius,
  }).mul(snowColor).mul(mask);
  const emissive = sunRadiance.mul(glint).mul(0.55).add(subsurface);

  // Wind-packed crests are a little smoother than the loose snow in troughs.
  const windRoughness = mix(
    snow.roughness.base + snow.roughness.variation,
    snow.roughness.base - snow.roughness.variation,
    relief.x.div(RELIEF_TONE_HEIGHT).clamp(-1, 1).mul(0.5).add(0.5),
  );
  const roughness = mix(windRoughness, snow.roughness.compressed, compressed);
  const bermRoughness = mix(roughness, snow.roughness.berm, berm);

  return {
    mask,
    color: snowColor,
    normal: snowViewNormal,
    roughness: bermRoughness.add(roughnessDetail).clamp(0, 1),
    emissive,
    depression,
    berm,
  };
}
