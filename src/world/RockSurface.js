import {
  Fn,
  If,
  cameraPosition,
  cameraViewMatrix,
  color,
  float,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  sin,
  texture,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { noise2 } from './snowNoiseNodes.js';
import { getSurfaceDetail } from '../rendering/surfaceDetail.js';
import { luminance } from './surfaceDetailNodes.js';

// Water stains are a cool dark grey; mineral (iron) stains a warm ochre.
const STAIN_DARK = [0.52, 0.55, 0.58];
const STAIN_OCHRE = [0.86, 0.66, 0.44];
const LEDGE_MOSS = '#5e7036';
// Below this rock weight the noise-driven detail is skipped.
const ROCK_DETAIL_EPSILON = 0.004;
// Snow cover above which the rock under it is not seen.
const FULL_COVER = 0.995;
// Beyond this (metres) streaks, strata and ledges are sub-pixel.
const NEAR_DETAIL_DISTANCE = 320;

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number.`);
  return number;
}

function positiveNumber(value, name) {
  const number = finiteNumber(value, name);
  if (!(number > 0)) throw new Error(`${name} must be greater than zero.`);
  return number;
}

function interval(value, name) {
  if (!value || typeof value !== 'object') throw new Error(`${name} configuration is required.`);
  const start = finiteNumber(value.start, `${name}.start`);
  const full = finiteNumber(value.full, `${name}.full`);
  if (!(full > start)) throw new Error(`${name}.full must be greater than ${name}.start.`);
  return { start, full };
}

export function resolveRockSurfaceConfig(config) {
  const rock = config?.ground?.rock;
  if (!rock) throw new Error('ground.rock configuration is required.');
  const textureBlendStart = finiteNumber(rock.textureBlendStart, 'ground.rock.textureBlendStart');
  const textureBlendEnd = finiteNumber(rock.textureBlendEnd, 'ground.rock.textureBlendEnd');
  if (!(textureBlendEnd > textureBlendStart)) {
    throw new Error('ground.rock.textureBlendEnd must be greater than ground.rock.textureBlendStart.');
  }
  return {
    highland: interval(rock.highland, 'ground.rock.highland'),
    cliffSlope: interval(rock.cliffSlope, 'ground.rock.cliffSlope'),
    cliffAltitude: interval(rock.cliffAltitude, 'ground.rock.cliffAltitude'),
    highlandStrength: finiteNumber(rock.highlandStrength, 'ground.rock.highlandStrength'),
    cliffStrength: finiteNumber(rock.cliffStrength, 'ground.rock.cliffStrength'),
    riverBankStrength: finiteNumber(rock.riverBankStrength, 'ground.rock.riverBankStrength'),
    lakeBedStrength: finiteNumber(rock.lakeBedStrength, 'ground.rock.lakeBedStrength'),
    rockyArea: {
      center: vec2(
        finiteNumber(rock.rockyArea.center[0], 'ground.rock.rockyArea.center[0]'),
        finiteNumber(rock.rockyArea.center[1], 'ground.rock.rockyArea.center[1]'),
      ),
      radius: vec2(
        positiveNumber(rock.rockyArea.radius[0], 'ground.rock.rockyArea.radius[0]'),
        positiveNumber(rock.rockyArea.radius[1], 'ground.rock.rockyArea.radius[1]'),
      ),
      inner: finiteNumber(rock.rockyArea.inner, 'ground.rock.rockyArea.inner'),
      outer: finiteNumber(rock.rockyArea.outer, 'ground.rock.rockyArea.outer'),
      strength: finiteNumber(rock.rockyArea.strength, 'ground.rock.rockyArea.strength'),
    },
    triplanarScale: positiveNumber(rock.triplanarScale, 'ground.rock.triplanarScale'),
    secondaryTriplanarScale: positiveNumber(rock.secondaryTriplanarScale, 'ground.rock.secondaryTriplanarScale'),
    textureBlendStart,
    textureBlendEnd,
    triplanarSharpness: positiveNumber(rock.triplanarSharpness, 'ground.rock.triplanarSharpness'),
    textureStrength: finiteNumber(rock.textureStrength, 'ground.rock.textureStrength'),
    textureBias: finiteNumber(rock.textureBias, 'ground.rock.textureBias'),
    grainFrequencyX: positiveNumber(rock.grainFrequencyX, 'ground.rock.grainFrequencyX'),
    grainFrequencyZ: positiveNumber(rock.grainFrequencyZ, 'ground.rock.grainFrequencyZ'),
    grainWarpFrequency: positiveNumber(rock.grainWarpFrequency, 'ground.rock.grainWarpFrequency'),
    grainAmplitude: finiteNumber(rock.grainAmplitude, 'ground.rock.grainAmplitude'),
    strataFrequency: positiveNumber(rock.strataFrequency, 'ground.rock.strataFrequency'),
    strataMacroInfluence: finiteNumber(rock.strataMacroInfluence, 'ground.rock.strataMacroInfluence'),
    strataAmplitude: finiteNumber(rock.strataAmplitude, 'ground.rock.strataAmplitude'),
    normalFrequency: vec3(
      positiveNumber(rock.normalFrequency[0], 'ground.rock.normalFrequency[0]'),
      positiveNumber(rock.normalFrequency[1], 'ground.rock.normalFrequency[1]'),
      positiveNumber(rock.normalFrequency[2], 'ground.rock.normalFrequency[2]'),
    ),
    normalStrength: finiteNumber(rock.normalStrength, 'ground.rock.normalStrength'),
    dryRoughness: finiteNumber(rock.dryRoughness, 'ground.rock.dryRoughness'),
    wetRoughness: finiteNumber(rock.wetRoughness, 'ground.rock.wetRoughness'),
    roughnessTextureStrength: finiteNumber(rock.roughnessTextureStrength, 'ground.rock.roughnessTextureStrength'),
    colors: {
      shadow: rock.colors.shadow,
      sun: rock.colors.sun,
      lake: rock.colors.lake,
    },
    lakeColorStrength: finiteNumber(rock.lakeColorStrength, 'ground.rock.lakeColorStrength'),
    wetDarkening: finiteNumber(rock.wetDarkening, 'ground.rock.wetDarkening'),
  };
}

function triplanar(textureObject, scale, weights) {
  const world = positionWorld;
  const x = texture(textureObject, world.yz.mul(scale));
  const y = texture(textureObject, world.xz.mul(scale));
  const z = texture(textureObject, world.xy.mul(scale));
  const denominator = weights.x.add(weights.y).add(weights.z).max(0.001);
  return x.mul(weights.x).add(y.mul(weights.y)).add(z.mul(weights.z)).div(denominator);
}

// `curvature` (optional) is heightfieldCurvature: positive in hollows,
// negative on ridges. `cover` (optional) is the snow mask laid over the rock;
// where it is complete the rock's detail is skipped.
export function createRockSurfaceNodes({
  config, colorTexture, roughnessTexture, macro, wet, riverBank, lakeBed, curvature = null, cover = null,
}) {
  const rock = resolveRockSurfaceConfig(config);
  const detail = getSurfaceDetail(config);
  const detailSettings = detail.settings.rock;
  const world = positionWorld.xz;
  const highland = positionWorld.y.smoothstep(rock.highland.start, rock.highland.full);
  const cliff = normalWorld.y.abs().smoothstep(rock.cliffSlope.start, rock.cliffSlope.full).oneMinus();
  const cliffAltitude = positionWorld.y.smoothstep(rock.cliffAltitude.start, rock.cliffAltitude.full);
  const rockyArea = world.sub(rock.rockyArea.center).div(rock.rockyArea.radius).length()
    .smoothstep(rock.rockyArea.inner, rock.rockyArea.outer).oneMinus();
  const mask = highland.mul(rock.highlandStrength)
    .max(cliff.mul(cliffAltitude).mul(rock.cliffStrength))
    .max(riverBank.mul(rock.riverBankStrength))
    .max(rockyArea.mul(rock.rockyArea.strength))
    .max(lakeBed.mul(rock.lakeBedStrength))
    .clamp(0, 1);

  const weights = normalWorld.abs().pow(rock.triplanarSharpness);
  const primaryStone = triplanar(colorTexture, rock.triplanarScale, weights).rgb;
  const secondaryStone = triplanar(colorTexture, rock.secondaryTriplanarScale, weights).rgb;
  const textureBlend = macro.smoothstep(rock.textureBlendStart, rock.textureBlendEnd);
  const stoneTexture = mix(primaryStone, secondaryStone, textureBlend);
  const roughnessSample = triplanar(roughnessTexture, rock.triplanarScale, weights).r;
  // Gradient noise at the configured grain frequencies. A product of sines
  // prints a regular lattice of dots across every cliff face. Height is folded
  // into both axes so a vertical wall varies down its face instead of
  // streaking.
  const grainPoint = vec2(
    positionWorld.x.add(positionWorld.y.mul(0.62)).mul(rock.grainFrequencyX),
    positionWorld.z.sub(positionWorld.y.mul(0.47)).mul(rock.grainFrequencyZ),
  ).div(Math.PI * 2);
  const grainWarp = sin(world.y.mul(rock.grainWarpFrequency)).mul(0.35);
  const grains = noise2(grainPoint.add(vec2(grainWarp, 0))).mul(1.4)
    .mul(rock.grainAmplitude).add(1 - rock.grainAmplitude);
  const baseColor = mix(
    mix(color(rock.colors.shadow), color(rock.colors.sun), macro),
    color(rock.colors.lake),
    lakeBed.mul(rock.lakeColorStrength),
  );
  const litStone = baseColor
    .mul(stoneTexture.mul(rock.textureStrength).add(rock.textureBias))
    .mul(grains);

  // Steep faces, for the streaks and ledges below.
  const steep = normalWorld.y.abs().smoothstep(0.35, 0.82).oneMinus();
  const far = cameraPosition.distance(positionWorld)
    .smoothstep(detailSettings.distance.range[0], detailSettings.distance.range[1]);
  const holds = normalWorld.y.smoothstep(0.18, 0.4).mul(normalWorld.y.smoothstep(0.62, 0.8).oneMinus());
  const streaks = detailSettings.streaks;

  // Every noise-driven term (strata, stains, far drift, ledges, the detail
  // normal) only shows on bare rock, and the terrain covers most of the
  // screen, so it is evaluated only there: branches on the rock mask and the
  // snow over it, holding only arithmetic (no texture reads). Skipped, they
  // are neutral: no tint, no ledge, the mesh normal. The near terms stop
  // where they would be sub-pixel; the drift starts where it applies.
  const distance = cameraPosition.distance(positionWorld);
  const bareRock = mask.greaterThan(ROCK_DETAIL_EPSILON)
    .and(cover ? cover.lessThan(FULL_COVER) : mask.greaterThan(0));
  const nearActive = detail.strata.add(detail.streaks).add(detail.ledges);
  const detailTerms = Fn(() => {
    const result = vec4(1, 1, 1, 0).toVar();
    If(bareRock.and(nearActive.greaterThan(0)).and(distance.lessThan(NEAR_DETAIL_DISTANCE)), () => {
      // Strata follow a gently dipping bedding plane, bent by broad folds, so
      // they read as geology rather than level contour stripes.
      const [dipX, dipZ] = detailSettings.strata.dip;
      // Folds from a warped sine product: broad and smooth, and far cheaper
      // than noise over rock that can fill the screen.
      const foldPoint = positionWorld.xz.mul(detailSettings.strata.warpScale * Math.PI * 2);
      const folds = sin(foldPoint.x.add(sin(foldPoint.y.mul(1.3)).mul(1.7))).mul(sin(foldPoint.y.mul(0.8).add(1.1)));
      const bedding = positionWorld.y.add(positionWorld.x.mul(dipX)).add(positionWorld.z.mul(dipZ))
        .add(folds.mul(detailSettings.strata.warp));
      const beddingHeight = mix(positionWorld.y, bedding, detail.strata);
      const strata = sin(beddingHeight.mul(rock.strataFrequency)
        .add(macro.mul(rock.strataMacroInfluence)))
        .mul(rock.strataAmplitude).add(1 - rock.strataAmplitude);

      // Rain streaks: water running down the faces leaves long dark stains,
      // some iron-ochre. Noise stretched down the face, read along a
      // horizontal coordinate blended between the two vertical planes by the
      // normal, so it runs vertically on any wall and stays continuous across
      // terrain facets, for one noise instead of two projections.
      const sideWeights = vec2(normalWorld.x.abs(), normalWorld.z.abs()).pow(4);
      const across = positionWorld.z.mul(sideWeights.x).add(positionWorld.x.mul(sideWeights.y))
        .div(sideWeights.x.add(sideWeights.y).max(1e-4));
      const stain = noise2(vec2(across.div(streaks.width), positionWorld.y.div(streaks.length))).smoothstep(0.05, 0.45);
      // Iron stains in broad bands along the face (a sine product, no noise).
      const mineral = sin(across.mul(0.23).add(positionWorld.y.mul(0.031)))
        .mul(sin(across.mul(0.071).sub(1.7))).smoothstep(0.1, 0.5).mul(streaks.ochre);
      const stainTint = mix(vec3(...STAIN_DARK), vec3(...STAIN_OCHRE), mineral);
      const stained = mix(vec3(1), stainTint, stain.mul(steep).mul(detail.streaks));

      // Ledges: chunky patches, several metres across, where the face is
      // steep but not sheer and the patch noise is high.
      const ledgePatch = noise2(positionWorld.xz.mul(0.12).add(vec2(positionWorld.y.mul(0.2), 23.1)));
      const ledge = ledgePatch.smoothstep(detailSettings.ledges.threshold - 0.45, detailSettings.ledges.threshold - 0.2)
        .mul(holds).mul(detail.ledges);
      result.assign(vec4(stained.mul(strata), ledge));
    });
    return result;
  })().toVar();
  // Far off, a broad colour drift so whole peaks do not share one grey.
  const driftTerm = Fn(() => {
    const result = vec3(1).toVar();
    If(bareRock.and(far.mul(detail.distance).greaterThan(0)), () => {
      const drift = noise2(positionWorld.xz.mul(detailSettings.distance.scale)).mul(1.4);
      const driftTint = mix(vec3(1.08, 1.0, 0.9), vec3(0.9, 0.96, 1.06), drift.mul(0.5).add(0.5))
        .mul(drift.mul(0.18).add(1));
      result.assign(mix(vec3(1), driftTint, far.mul(detail.distance)));
    });
    return result;
  })();

  // Crevices darken, exposed edges and ridges wear lighter (no noise: the
  // curvature is shared with the snow).
  let weathered = litStone.mul(detailTerms.xyz).mul(driftTerm);
  if (curvature) {
    const scale = detailSettings.curvature.scale;
    const hollow = curvature.div(scale).clamp(0, 1);
    const ridge = curvature.negate().div(scale).clamp(0, 1);
    weathered = weathered.mul(hollow.mul(detail.crevice).mul(0.6).oneMinus())
      .mul(ridge.mul(detail.edge).mul(0.45).add(1));
  }

  // Ledges hold snow up in snow country; below it a muted lichen that only
  // tints the stone, so low ledges do not read as painted green stripes.
  const ledge = detailTerms.w;
  const snowSettings = config.ground?.snow;
  const snowy = snowSettings?.enabled && snowSettings.altitude
    ? positionWorld.y.smoothstep(snowSettings.altitude.start, snowSettings.altitude.full)
    : float(0);
  const lichen = mix(weathered, weathered.mul(color(LEDGE_MOSS)).mul(2.2), 0.45);
  const snowCover = color(snowSettings?.colors?.base ?? '#e4eaf1').mul(luminance(litStone).mul(0.35).add(0.75));
  const ledged = mix(weathered, mix(lichen, snowCover, snowy), ledge.mul(mix(float(0.5), float(1), snowy)));

  const surfaceColor = ledged.mul(wet.mul(rock.wetDarkening).oneMinus());

  // Gradient noise, not sines: summed sines of two axes print a regular
  // lattice of dimples down every steep face. Height is folded in so walls
  // vary down their face, as with the grain. Only where there is rock.
  const facet = (frequency, x, z, offset) => noise2(vec2(x, z).mul(frequency).div(Math.PI * 2).add(offset)).mul(1.4);
  const normalDetail = Fn(() => {
    const result = vec3(0).toVar();
    If(mask.greaterThan(ROCK_DETAIL_EPSILON), () => {
      result.assign(vec3(
        facet(rock.normalFrequency.x, positionWorld.y.add(positionWorld.x.mul(0.3)), positionWorld.z, 0),
        facet(rock.normalFrequency.y, positionWorld.x, positionWorld.z, 17.3).mul(0.35),
        facet(rock.normalFrequency.z, positionWorld.y.sub(positionWorld.z.mul(0.3)), positionWorld.x, 41.9),
      ).mul(rock.normalStrength));
    });
    return result;
  })().mul(mask);
  const surfaceNormal = normalize(
    cameraViewMatrix.mul(vec4(normalize(normalWorld.add(normalDetail)), 0)).xyz,
  );
  const sampledRoughness = mix(rock.dryRoughness, roughnessSample, rock.roughnessTextureStrength);
  const surfaceRoughness = mix(sampledRoughness, rock.wetRoughness, wet);

  // The stone's own relief as a 0..1 height, for height-blended transitions:
  // bright grains stand proud, dark ones sit low.
  const height = luminance(stoneTexture).mul(grains).mul(1.4).clamp(0, 1);
  return {
    mask,
    color: surfaceColor,
    normal: surfaceNormal,
    roughness: mix(surfaceRoughness, float(0.8), ledge.mul(0.6)),
    height,
    ledge,
  };
}
