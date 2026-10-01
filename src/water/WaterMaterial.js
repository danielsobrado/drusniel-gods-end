import * as THREE from 'three/webgpu';
import { WaterRefractionNode } from './WaterRefractionNode.js';
import {
  Discard,
  Fn,
  If,
  abs,
  attribute,
  bool,
  cameraPosition,
  color,
  cubeTexture,
  dot,
  dFdx,
  dFdy,
  float,
  fract,
  max,
  mix,
  nodeObject,
  normalize,
  normalWorld,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  screenUV,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
  viewportSafeUV,
} from 'three/tsl';
import { riverField } from './riverNodes.js';
import { MOUTH_HANDOVER_HEIGHT } from './RiverCourse.js';
import { createSeaNodes } from './seaNodes.js';
import { SEA_SHORE_OPACITY_END, SEA_SHORE_OPACITY_START } from '../world/CoastField.js';
import { SEA_COMPONENTS } from './seaWaves.js';
import { createWaterfallTexture, WATERFALL_TILE_WIDTH } from './waterfallTexture.js';
import { createSceneLight, SKY_GAIN } from './sceneLight.js';
import {
  createSeaDetailTexture,
  SEA_DETAIL_MOMENT_SCALE,
  SEA_DETAIL_SLOPE_RANGE,
} from './seaDetail.js';

// Metres of channel edge the ribbon fades across once it has handed over to the
// sea. A channel bank's width, at a mouth where the estuary is 70 m wide, draws
// the ribbon's own outline on the water.
const MOUTH_EDGE_FADE = 24;

export function createWaterDetailTexture() {
  const size = 256, data = new Uint8Array(size * size * 4);
  const noise = (x, y, cells) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const hash = (a, b) => {
      const n = Math.sin(((a + cells) % cells) * 127.1 + ((b + cells) % cells) * 311.7) * 43758.5453;
      return n - Math.floor(n);
    };
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), sx),
      THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), sx),
      sy,
    );
  };
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const u = x / size * Math.PI * 2, v = y / size * Math.PI * 2;
    const dx = Math.cos(u * 3 + v * 4 + Math.sin(v * 2)) * 0.28
      + Math.cos(u * 5 - v * 2) * 0.19
      + Math.cos(u * 7 + v * 9 + Math.sin(u * 3)) * 0.09
      + Math.cos(u * 13 - v * 7) * 0.05;
    const dz = Math.cos(u * 3 + v * 4 + Math.sin(v * 2)) * 0.24
      - Math.cos(u * 5 - v * 2) * 0.12
      + Math.cos(u * 7 + v * 9 + Math.sin(u * 3)) * 0.13
      - Math.cos(u * 13 - v * 7) * 0.03;
    const k = (y * size + x) * 4;
    data[k] = Math.round((dx * 0.5 + 0.5) * 255);
    data[k + 1] = Math.round((dz * 0.5 + 0.5) * 255);
    data[k + 2] = Math.round((noise(x / size * 8, y / size * 8, 8) * 0.55
      + noise(x / size * 16, y / size * 16, 16) * 0.3
      + noise(x / size * 32, y / size * 32, 32) * 0.15) * 255);
    data[k + 3] = 255;
  }
  const result = new THREE.DataTexture(data, size, size);
  result.wrapS = result.wrapT = THREE.RepeatWrapping;
  result.minFilter = THREE.LinearMipmapLinearFilter;
  result.magFilter = THREE.LinearFilter;
  result.generateMipmaps = true;
  result.anisotropy = 8;
  result.needsUpdate = true;
  return result;
}

export function createCinematicWaterMaterial({
  terrain,
  river,
  params,
  reflection,
  planar,
  seaPlanar,
  lakeReprojection = null,
  seaReprojection = null,
  skyColorProvider = null,
  snowAltitude = null,
}) {
  const seaPalette = params.sea?.colors ?? {};
  const seaAbsorption = params.sea?.absorption ?? [0.32, 0.065, 0.05];
  const seaLagoonDepth = params.sea?.lagoonDepth ?? [0.5, 7];
  const detail = createWaterDetailTexture();
  const falls = createWaterfallTexture();
  const light = createSceneLight();
  const uniforms = {
    clock: uniform(0),
    rain: uniform(0),
    sunColor: uniform(new THREE.Color('#fff0cc')),
    sunDirection: uniform(new THREE.Vector3(-0.4, 0.8, -0.4)),
    sunStrength: uniform(1),
    footsteps: uniformArray(Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, -100, 0))),
    rich: uniform(1),
    seaFineDetail: uniform(1),
  };
  const t = uniforms.clock;
  const body = attribute('waterKind', 'float');
  const kind = body.greaterThan(0.5).and(body.lessThan(1.5)).select(float(1), float(0));
  const sea = body.greaterThan(1.5).select(float(1), float(0));
  const ocean = createSeaNodes(params.sea, t, uniforms.rain);
  const seaParams = ocean.params;
  const seaArt = seaParams.detail;
  // Resolve and validate the sea config before paying the startup cost of the
  // procedural detail texture, and build it from the same resolved choppiness.
  const seaDetail = params.sea?.enabled ? createSeaDetailTexture(seaParams.choppiness) : detail;
  const flowData = attribute('waterFlow', 'vec4');
  const surface = attribute('riverSurface', 'vec4');
  const currentUv = vec2(surface.x.mul(0.22), surface.y.mul(0.045).sub(t.mul(0.28)));
  const level = attribute('waterLevel', 'float');
  // Signed distance to the lake's outline, baked per vertex (waterGeometry):
  // the lake's surface covers the points inside it and the ribbon hands over.
  const lakeDistance = attribute('lakeMask', 'float');
  const lakeHere = lakeDistance.lessThan(0);
  const current = kind.mul(lakeHere.select(level.sub(params.position[1]).smoothstep(0, 2), float(1)));
  // Snowmelt: up in snow country the river runs cold and dark, and reflects
  // the sky it runs under rather than the meadow probe captured down at the
  // lake.
  const alpine = snowAltitude
    ? level.smoothstep(snowAltitude.start, snowAltitude.full).mul(kind).toVar()
    : float(0);
  // The outlet's last stretch runs at the sea's own level, where the ribbon is
  // the same body of water as the sea beside it. Across it the ribbon's colour,
  // depth falloff, surface and edge fade all cross over to the sea's, so the
  // flow dissolves into the sea instead of ending on a line of its own colour.
  // The same height governs the carve and the ribbon's width (RiverCourse).
  const mouth = params.sea?.enabled
    ? level.sub(seaParams.level).smoothstep(0.1, MOUTH_HANDOVER_HEIGHT).oneMinus().mul(current).toVar()
    : float(0);
  // What looks like sea water here: the sea itself, and the ribbon at the mouth.
  const seaLook = sea.max(mouth).toVar();
  const detailUv = mix(positionWorld.xz.mul(0.065), currentUv, current);
  const bank = riverField(river).toVar();
  const terrainUv = positionWorld.xz.sub(vec2(terrain.boundsMin.x, terrain.boundsMin.z))
    .div(vec2(terrain.boundsSize.x, terrain.boundsSize.z)).clamp(0, 1);
  const groundY = texture(terrain.texture, terrainUv).r
    .mul(terrain.maxHeight - terrain.minHeight).add(terrain.minHeight);
  // This is the CoastField-owned mean-depth handoff. GroundMaterial uses its
  // complement, so swash film and sea opacity meet without a shoreline cut.
  // The sea fades in over real depth of ground below still water, the exact
  // complement of the ground's swash handoff (GroundMaterial). Placing it by
  // the analytic coast curve left it cut short where erosion raised the sand,
  // so a strip of beach separated sea from swash.
  const groundBelowSea = float(seaParams.level).sub(groundY).toVar();
  // Optical depth follows the real bed as well: the analytic depth is zero
  // wherever erosion put the waterline seaward of the coast curve, and there
  // the water tinted nothing, a grey strip of bare sand and sky reflection
  // along the shore. Seaward of the curve the bed follows the analytic
  // profile, so the open sea is unchanged.
  const oceanDepth = ocean.depth(positionWorld.xz).max(groundBelowSea)
    .add(positionWorld.y.sub(seaParams.level));
  const depth = mix(positionWorld.y.sub(groundY), oceanDepth, sea).max(0);
  const seaCoverage = groundBelowSea.smoothstep(SEA_SHORE_OPACITY_START, SEA_SHORE_OPACITY_END).toVar();
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  material.name = 'Mountain river, lake and coast';
  // Lake and ribbon both reach across the river mouths; each keeps only its
  // own side of the outline, so no two water layers ever overlap there.
  material.maskNode = body.lessThan(0.5).select(lakeDistance.lessThanEqual(0),
    body.lessThan(1.5).select(lakeDistance.greaterThanEqual(0), bool(true)));

  const broadWaves = Fn(([p]) => sin(p.x.mul(0.27).add(p.y.mul(0.11)).sub(t.mul(0.72))).mul(0.065)
    .add(sin(p.x.mul(-0.14).add(p.y.mul(0.31)).sub(t.mul(0.49))).mul(0.035)));
  const localWorld = positionLocal.xz.add(vec2(params.position[0], params.position[2]));
  material.positionNode = Fn(() => {
    const displacement = float(0).toVar();
    If(body.greaterThan(1.5), () => {
      displacement.assign(ocean.height(localWorld));
    }).Else(() => {
      displacement.assign(broadWaves(positionLocal.xz)
        .mul(kind.mul(level.sub(params.position[1]).smoothstep(0, 2)).mul(-0.5).add(1)));
    });
    return positionLocal.add(vec3(0, displacement, 0));
  })();

  const worldDx = dFdx(positionWorld.xz).toVar();
  const worldDy = dFdy(positionWorld.xz).toVar();
  const detailDx = dFdx(detailUv).toVar();
  const detailDy = dFdy(detailUv).toVar();
  const flow = mix(vec2(0.13, 0.07), vec2(0, 0.2), current);
  const flowDx = dFdx(flow).toVar();
  const flowDy = dFdy(flow).toVar();
  const currentDx = dFdx(currentUv).toVar();
  const currentDy = dFdy(currentUv).toVar();
  // Falling water is textured across in tiles and down in seconds of travel,
  // so its streaks move at the water's own speed (see measureRiverSurface).
  const travel = flowData.w;
  const fallUv = vec2(surface.x.div(WATERFALL_TILE_WIDTH), travel);
  const fallDx = dFdx(fallUv).toVar();
  const fallDy = dFdy(fallUv).toVar();
  // Force explicit texture gradients into uniform control flow before any
  // per-body or distance branch. Body attributes are constant per triangle.
  const gradientsReady = worldDx.x.equal(worldDx.x).and(worldDy.x.equal(worldDy.x))
    .and(detailDx.x.equal(detailDx.x)).and(detailDy.x.equal(detailDy.x))
    .and(flowDx.x.equal(flowDx.x)).and(flowDy.x.equal(flowDy.x))
    .and(currentDx.x.equal(currentDx.x)).and(currentDy.x.equal(currentDy.x))
    .and(fallDx.x.equal(fallDx.x)).and(fallDy.x.equal(fallDy.x));
  // Rest position of the water under this point: the swell's orbital motion
  // carries short waves back and forth with it (Gerstner horizontal motion of
  // the heightfield swell), so ripples ride the big waves.
  const orbit = Fn(() => {
    const p = positionWorld.xz;
    const offset = vec2(0).toVar();
    for (const wave of SEA_COMPONENTS.slice(0, 3)) {
      const phase = p.x.mul(wave.x).add(p.y.mul(wave.z)).mul(wave.waveNumber)
        .add(t.mul(wave.angularSpeed)).add(wave.phase);
      offset.addAssign(vec2(wave.x, wave.z).mul(phase.cos().mul(wave.weight)));
    }
    return offset.mul(ocean.amplitude(p).mul(seaArt.orbitalAdvection ?? 0.8));
  })();
  const layerUv = (wave, scale, scrollSpeed, turn = 0) => {
    const p = positionWorld.xz.add(orbit);
    if (turn) {
      const c = Math.cos(turn), s = Math.sin(turn);
      wave = { x: wave.x * c - wave.z * s, z: wave.x * s + wave.z * c };
    }
    const along = p.x.mul(wave.x).add(p.y.mul(wave.z));
    const across = p.x.mul(-wave.z).add(p.y.mul(wave.x));
    return vec2(along, across).mul(scale / seaArt.textureWorldScale)
      .add(vec2(t.mul(scrollSpeed), 0));
  };
  const layerGradient = (delta, wave, scale, turn = 0) => {
    if (turn) {
      const c = Math.cos(turn), s = Math.sin(turn);
      wave = { x: wave.x * c - wave.z * s, z: wave.x * s + wave.z * c };
    }
    return rotateGradient(delta, wave, scale);
  };
  const rotateGradient = (delta, wave, scale) => vec2(
    delta.x.mul(wave.x).add(delta.y.mul(wave.z)),
    delta.x.mul(-wave.z).add(delta.y.mul(wave.x)),
  ).mul(scale / seaArt.textureWorldScale);
  const layerSample = (wave, scale, scrollSpeed, turn = 0) => texture(seaDetail, layerUv(wave, scale, scrollSpeed, turn))
    .grad(layerGradient(worldDx, wave, scale, turn), layerGradient(worldDy, wave, scale, turn));
  const oneSlope = (wave, scale, scrollSpeed, turn) => {
    const local = layerSample(wave, scale, scrollSpeed, turn).rg
      .mul(2).sub(1).mul(SEA_DETAIL_SLOPE_RANGE);
    const c = Math.cos(turn), s = Math.sin(turn);
    const x = wave.x * c - wave.z * s, z = wave.x * s + wave.z * c;
    return vec2(local.x.mul(x).sub(local.y.mul(z)), local.x.mul(z).add(local.y.mul(x)));
  };
  // Two trains crossing at ~50 degrees at slightly different speeds: their
  // interference keeps changing, so the ripples evolve instead of one tile
  // translating rigidly across the sea.
  const layerSlope = (wave, scale, scrollSpeed) => oneSlope(wave, scale, scrollSpeed, 0.45)
    .add(oneSlope(wave, scale * 1.13, scrollSpeed * 0.83, -0.42)).mul(0.62);
  const primaryScrollSpeed = Math.hypot(seaArt.primaryScrollX, seaArt.primaryScrollZ);
  const secondaryScrollSpeed = Math.hypot(seaArt.secondaryScrollX, seaArt.secondaryScrollZ);
  const fineScrollSpeed = Math.hypot(seaArt.fineScrollX, seaArt.fineScrollZ);
  const broadSeaNormal = ocean.normal(positionWorld.xz);
  const onlySea = (expression, neutral = float(0)) => Fn(() => {
    const value = neutral.toVar();
    If(body.greaterThan(1.5).and(gradientsReady), () => { value.assign(expression); });
    return value;
  })();

  const normals = Fn(() => {
    const slope = vec2(0).toVar();
    If(body.greaterThan(1.5).and(gradientsReady), () => {
      const distanceToCamera = cameraPosition.distance(positionWorld);
      const mediumFade = distanceToCamera
        .smoothstep(seaArt.mediumDistance * 0.55, seaArt.mediumDistance).oneMinus();
      const fineFade = distanceToCamera
        .smoothstep(seaArt.fineDistance * 0.55, seaArt.fineDistance).oneMinus()
        .mul(uniforms.seaFineDetail);
      If(mediumFade.greaterThan(0), () => {
        const first = layerSlope(SEA_COMPONENTS[0], 1, primaryScrollSpeed);
        const second = layerSlope(SEA_COMPONENTS[1], seaArt.mediumScale, secondaryScrollSpeed);
        slope.assign(first.mul(seaArt.primaryWeight).add(second.mul(seaArt.secondaryWeight)).mul(mediumFade));
      });
      If(fineFade.greaterThan(0), () => {
        const fine = layerSlope(SEA_COMPONENTS[2], seaArt.fineScale, fineScrollSpeed);
        slope.addAssign(fine.mul(seaArt.fineStrength).mul(fineFade));
      });
      // Short-wave normals stay subtle on steep carrier faces. This makes the
      // detail read as surface texture instead of independent waves pasted on
      // top of a moving swell.
      const carrierFlatness = broadSeaNormal.y
        .smoothstep(seaArt.carrierSlopeFadeStart, seaArt.carrierSlopeFadeEnd);
      const offshoreStrength = mix(float(0.12), float(seaArt.mediumStrength), ocean.offshore(positionWorld.xz));
      slope.mulAssign(offshoreStrength.mul(carrierFlatness).mul(seaParams.detailStrength)
        .mul(uniforms.rain.mul(seaArt.stormNormalBoost).add(1)));
    }).Else(() => {
      const phase = fract(t.mul(0.09));
      const phaseB = fract(phase.add(0.5));
      const blend = abs(phase.mul(2).sub(1));
      const a = texture(detail, detailUv.sub(flow.mul(phase))).grad(detailDx.sub(flowDx.mul(phase)), detailDy.sub(flowDy.mul(phase))).rg.mul(2).sub(1);
      const b = texture(detail, detailUv.sub(flow.mul(phaseB))).grad(detailDx.sub(flowDx.mul(phaseB)), detailDy.sub(flowDy.mul(phaseB))).rg.mul(2).sub(1);
      const micro = texture(detail, detailUv.mul(3.7).add(vec2(t.mul(-0.018), t.mul(0.013))))
        .grad(detailDx.mul(3.7), detailDy.mul(3.7)).rg.mul(2).sub(1);
      slope.assign(mix(a, b, blend).mul(mix(0.15, 0.16, current)).add(micro.mul(0.025)));
    });

    const acrossNormal = vec3(flowData.y.negate(), 0, flowData.x);
    const flowVector = vec3(flowData.x, surface.z.negate(), flowData.y);
    const downstream = flowVector.div(flowVector.length().max(0.0001));
    const riverNormal = acrossNormal.mul(slope.x).add(downstream.mul(slope.y));
    const impacts = vec2(0).toVar();
    for (let i = 0; i < 8; i += 1) {
      const foot = uniforms.footsteps.element(i);
      If(foot.w.greaterThan(0), () => {
        const age = t.sub(foot.z).max(0);
        const delta = positionWorld.xz.sub(foot.xy);
        const distance = delta.length().max(0.001);
        const ring = distance.sub(age.mul(2.3));
        const pulse = sin(ring.mul(15)).mul(ring.mul(ring).mul(-5).exp())
          .mul(age.mul(-1.2).exp()).mul(foot.w).mul(0.12);
        impacts.addAssign(delta.div(distance).mul(pulse));
      });
    }
    const rain = sin(positionWorld.xz.mul(17).add(t.mul(7))).mul(0.05).mul(uniforms.rain);
    const base = normalWorld.toVar();
    // At the mouth the ribbon takes up the sea's swell, and its own ripple and
    // flow relief fade out, so the two surfaces move as one across the handover.
    If(body.greaterThan(1.5).or(mouth.greaterThan(0.001)), () => {
      base.assign(mix(base, broadSeaNormal, seaLook));
    });
    const disturbance = vec2(impacts.x.add(rain.x), impacts.y.add(rain.y));
    const inlandNormal = normalize(base
      .add(mix(vec3(slope.x.negate(), 0, slope.y.negate()), riverNormal, current).mul(mouth.oneMinus()))
      .add(vec3(disturbance.x.negate(), 0, disturbance.y.negate())));
    // ocean.normal() is already normalized, while the detail texture stores
    // height-field slopes. Recover the broad-wave gradient before adding the
    // smaller slopes; adding them directly to a unit normal overstates detail
    // on steep swells and makes the ripples look pasted onto the surface.
    const baseY = base.y.max(0.15);
    const seaNormal = normalize(vec3(
      base.x.div(baseY).sub(slope.x).sub(disturbance.x),
      1,
      base.z.div(baseY).sub(slope.y).sub(disturbance.y),
    ));
    return normalize(mix(inlandNormal, seaNormal, sea));
  });

  const refraction = nodeObject(new WaterRefractionNode());
  const cube = cubeTexture(reflection);
  const normalNode = normals();
  material.colorNode = Fn(() => {
    const riverHere = bank.y.lessThan(0)
      .and(bank.x.greaterThan(params.position[1]).or(lakeHere.not()));
    If(body.lessThan(0.5).and(riverHere), () => Discard());
    If(kind.greaterThan(0.5).and(riverHere.not()), () => Discard());
    If(sea.greaterThan(0.5).and(ocean.distance(positionWorld.xz).lessThan(-180)), () => Discard());
    If(sea.greaterThan(0.5).and(seaCoverage.lessThanEqual(0)), () => Discard());
    If(sea.lessThan(0.5).and(depth.lessThan(0.015)), () => Discard());

    const n = normalNode.toVar();
    const falling = surface.z.smoothstep(0.18, 0.65).mul(current);
    const view = normalize(cameraPosition.sub(positionWorld));
    const facing = dot(n, view).max(0);
    const fresnel = pow(float(1).sub(facing), mix(float(5), float(3), seaLook))
      .mul(mix(float(0.98), float(0.96), seaLook)).add(mix(float(0.02), float(0.04), seaLook));
    const distortion = n.xz.mul(0.014).mul(depth.smoothstep(0, 2));
    const refracted = refraction.sample(viewportSafeUV(screenUV.add(distortion))).rgb;
    // Where the ribbon lies over the open sea it takes the sea's own depth
    // falloff too, so the stretch the two share does not read as a tint of its
    // own. Inside the estuary it keeps the depth of the bed under it.
    const lookDepth = mix(depth, oceanDepth,
      mouth.mul(ocean.distance(positionWorld.xz).smoothstep(-6, 16)));
    const opticalDepth = lookDepth.div(dot(normalWorld, view).abs().max(0.25))
      .min(mix(float(28), float(120), seaLook)).add(falling.mul(3));
    // Clear coastal sea water loses red within a few metres but carries green
    // and blue much further than the silty lake and river, so pale sand under
    // the shallows reads aquamarine instead of murky teal.
    const transmission = mix(vec3(0.22, 0.085, 0.06), vec3(...seaAbsorption), seaLook)
      .mul(opticalDepth.negate()).exp();
    const seaFloorDepth = ocean.depth(positionWorld.xz);
    const shallowColor = mix(
      mix(color(seaPalette.sunny?.lagoon ?? '#4fd3cf'), color(seaPalette.storm?.lagoon ?? '#2f8a80'), uniforms.rain),
      mix(color(seaPalette.sunny?.shallow ?? '#259eac'), color(seaPalette.storm?.shallow ?? '#176662'), uniforms.rain),
      seaFloorDepth.smoothstep(seaLagoonDepth[0], seaLagoonDepth[1]),
    );
    const seaColor = mix(
      shallowColor,
      mix(color(seaPalette.sunny?.deep ?? '#073c58'), color(seaPalette.storm?.deep ?? '#032d48'), uniforms.rain),
      seaFloorDepth.smoothstep(2, 24),
    ).mul(uniforms.sunStrength.mul(0.75).add(0.25));
    const inlandColor = mix(color('#164e52'), color('#246d70'), uniforms.sunStrength.mul(0.3).clamp(0, 1));
    const waterColor = mix(
      mix(inlandColor, color('#10303d'), alpine),
      seaColor,
      seaLook,
    );
    const underwater = refracted.mul(transmission).add(waterColor.mul(transmission.oneMinus()));
    const direction = reflect(view.negate(), n);
    const probe = cube.sample(direction).rgb;
    const fallbackSky = mix(color('#81a8b4'), color('#38658a'), direction.y.smoothstep(0, 0.7))
      .mul(uniforms.sunStrength.mul(0.85).add(0.12));
    const oceanSky = skyColorProvider ? skyColorProvider(direction) : fallbackSky;
    const reflected = mix(probe, oceanSky, skyColorProvider ? seaLook.max(alpine) : seaLook).toVar();

    if (planar) {
      const lakeWeight = level.sub(params.position[1]).abs().smoothstep(0.05, 3).oneMinus().mul(uniforms.rich);
      If(uniforms.rich.greaterThan(0.5), () => {
        // Captures are budgeted, so sample them through the camera they were
        // taken with rather than by screen position (see PlanarReprojection).
        const capture = lakeReprojection?.uvNode() ?? { uv: screenUV.flipX(), weight: float(1) };
        const lake = planar.sample(capture.uv.add(distortion)).rgb;
        reflected.assign(mix(probe, lake, lakeWeight.mul(capture.weight)));
      });
    }
    if (seaPlanar) If(uniforms.rich.greaterThan(0.5), () => {
      const capture = seaReprojection?.uvNode() ?? { uv: screenUV.flipX(), weight: float(1) };
      const sea = seaPlanar.sample(capture.uv.add(distortion)).rgb;
      reflected.assign(mix(
        reflected,
        mix(oceanSky, sea, capture.weight.mul(0.65)),
        seaLook,
      ));
    });

    const oceanUv = layerUv(SEA_COMPONENTS[0], 1, primaryScrollSpeed);
    const oceanDx = layerGradient(worldDx, SEA_COMPONENTS[0], 1);
    const oceanDy = layerGradient(worldDy, SEA_COMPONENTS[0], 1);
    const momentSample = texture(seaDetail, oceanUv).grad(oceanDx, oceanDy);
    const meanSlope = momentSample.rg.mul(2).sub(1).mul(SEA_DETAIL_SLOPE_RANGE);
    const secondMoment = momentSample.a.mul(SEA_DETAIL_MOMENT_SCALE);
    const variance = max(secondMoment.sub(dot(meanSlope, meanSlope)), float(0));
    const unresolvedRoughness = sqrt(variance).mul(seaArt.roughnessVarianceScale * seaParams.detailStrength);
    const seaRoughness = unresolvedRoughness.add(seaArt.roughnessBase).add(uniforms.rain.mul(seaArt.roughnessStorm)).clamp(seaArt.roughnessMin, seaArt.roughnessMax);
    const specularExponent = mix(
      float(seaArt.specularMaxExponent),
      float(seaArt.specularMinExponent),
      seaRoughness.smoothstep(seaArt.roughnessMin, seaArt.roughnessMax),
    );
    const spec = dot(reflect(uniforms.sunDirection.negate(), n), view).max(0);
    const sharpSpecular = pow(spec, specularExponent).mul(seaArt.specularSharpStrength);
    const broadSpecular = pow(spec, mix(float(24), float(8), seaRoughness))
      .mul(seaArt.specularBroadStrength);
    // Keep the established lake/river highlights; only sea water uses the
    // offshore roughness and art controls.
    const inlandSpecular = pow(spec, 170).mul(1.8).add(pow(spec, 20).mul(0.08));
    const glint = mix(inlandSpecular, onlySea(sharpSpecular.add(broadSpecular)), sea)
      .mul(uniforms.sunStrength).mul(uniforms.sunColor);

    const foamNoise = texture(detail, mix(
      detailUv,
      vec2(positionWorld.x.mul(0.055).add(t.mul(0.025)), positionWorld.z.mul(0.048)),
      sea,
    )).grad(mix(detailDx, worldDx.mul(vec2(0.055, 0.048)), sea),
      mix(detailDy, worldDy.mul(vec2(0.055, 0.048)), sea)).b;
    const turbulence = flowData.z.sub(0.7).mul(0.34).clamp(0, 0.65).mul(current);
    const shore = depth.smoothstep(0.02, 0.13).mul(depth.smoothstep(0.22, 0.75).oneMinus());
    const streaks = texture(detail, currentUv.mul(vec2(0.7, 2.4)).add(vec2(0.3, 0.1)))
      .grad(currentDx.mul(vec2(0.7, 2.4)), currentDy.mul(vec2(0.7, 2.4))).b;
    // The river's own shore and bank foam fade out at the mouth: they trace the
    // ribbon's edge, and the surf breaking across the estuary takes over there.
    const riverShore = foamNoise.smoothstep(0.48, 0.78)
      .mul(shore.mul(0.6).add(turbulence.mul(streaks.pow(3))))
      .mul(seaLook.oneMinus());

    // One wave front, placed by height (CoastField swash*): it forms in the
    // shallows, crosses the waterline and continues up the sand in the ground
    // shader as the same line, instead of a separate ring on each side.
    const sharedSurf = ocean.swashFoam(positionWorld.xz, groundBelowSea.negate())
      .mul(ocean.offshore(positionWorld.xz).oneMinus())
      .mul(groundBelowSea.smoothstep(seaArt.surfFadeStart, seaArt.surfFadeEnd).oneMinus())
      .mul(sea);
    // Breaking surf: where a set wave runs into water about its own height
    // deep it spills. A white roll rides its face and a lace of foam trails
    // behind it, thinning as it drifts back. Only the bigger waves of a set
    // break, so the surf line comes and goes along the shore.
    const breakAge = ocean.nearshorePhase(positionWorld.xz).sub(Math.PI / 2).div(Math.PI * 2).fract();
    const breakZone = groundBelowSea.smoothstep(seaArt.breakDepthStart, seaArt.breakDepthFull)
      .mul(groundBelowSea.smoothstep(seaArt.breakDepthFade, seaArt.breakDepthEnd).oneMinus())
      .mul(ocean.setEnvelope(positionWorld.xz)
        .smoothstep(1 - seaArt.setDepth * 0.6 - 0.001, 1 - seaArt.setDepth * 0.1))
      .mul(ocean.offshore(positionWorld.xz).oneMinus());
    const laceUv = positionWorld.xz.mul(seaArt.breakLaceScale).add(vec2(t.mul(0.021), t.mul(-0.013)));
    const lace = texture(detail, laceUv)
      .grad(worldDx.mul(seaArt.breakLaceScale), worldDy.mul(seaArt.breakLaceScale)).b;
    const roll = breakAge.smoothstep(0.86, 0.985).mul(lace.smoothstep(0.12, 0.3));
    const trail = breakAge.mul(-seaArt.breakTrail).exp()
      .mul(lace.smoothstep(breakAge.mul(0.9).add(0.12), breakAge.mul(0.9).add(0.3)));
    const breakers = roll.max(trail).mul(breakZone).mul(seaArt.breakStrength).mul(sea);
    const crestThreshold = mix(
      float(seaArt.whitecapThreshold),
      float(seaArt.stormWhitecapThreshold),
      uniforms.rain,
    );
    // Sea geometry is already displaced by ocean.height() in the vertex
    // stage. Read that interpolated surface height for crest foam instead of
    // evaluating all five swell components again in the fragment shader.
    const crestHeight = positionWorld.y.sub(seaParams.level)
      .div(ocean.amplitude(positionWorld.xz).max(0.001));
    const crest = crestHeight.smoothstep(crestThreshold, 0.98);
    const steepness = float(1).sub(broadSeaNormal.y)
      .smoothstep(seaArt.whitecapSteepness * 0.55, seaArt.whitecapSteepness);
    const whitecapBreakup = momentSample.b.mul(0.65)
      .add(texture(seaDetail, oceanUv.mul(1.79))
        .grad(oceanDx.mul(1.79), oceanDy.mul(1.79)).b.mul(0.35))
      .smoothstep(seaArt.foamBreakupLow, seaArt.foamBreakupHigh);
    const whitecaps = crest.mul(seaArt.whitecapCrestWeight).add(steepness.mul(seaArt.whitecapSteepnessWeight)).clamp(0, 1)
      .mul(whitecapBreakup)
      .mul(ocean.offshore(positionWorld.xz))
      .mul(seaParams.whitecapStrength)
      .mul(uniforms.rain.mul(seaArt.whitecapRainBoost).add(seaArt.whitecapRainBase))
      .mul(sea);

    const bankFoam = bank.y.abs().smoothstep(0.1, 1.15).oneMinus().mul(current)
      .mul(mouth.oneMinus())
      .mul(foamNoise.smoothstep(0.3, 0.75)).mul(0.5);
    // Falling water: fine strands and broader sheets streak down the fall on
    // its travel time, so they lengthen as the water accelerates and bunch up
    // at the foot. Slow patches thin and thicken the white, and it frays into
    // separate strands toward the banks. Below a drop two churn layers,
    // drifting at different speeds, boil in the plunge and break into foam
    // patches trailing downstream as the impact decays.
    const steep = surface.z.smoothstep(0.14, 0.75).mul(current);
    const plunge = surface.w.mul(current);
    const fall = vec3(0, 1, 1).toVar(); // foam, fringe opacity, foam shade
    If(body.lessThan(1.5).and(gradientsReady).and(steep.add(plunge).greaterThan(0.002)), () => {
      const layer = (map, scaleX, scaleY, drift, offsetX, offsetY) => texture(map, vec2(
        fallUv.x.mul(scaleX).add(offsetX),
        travel.sub(t.mul(drift)).mul(scaleY).add(offsetY),
      )).grad(fallDx.mul(vec2(scaleX, scaleY)), fallDy.mul(vec2(scaleX, scaleY)));
      const strands = layer(falls, 1, 0.3, 1, 0, 0).r;
      const sheets = layer(falls, 0.61, 0.19, 0.82, 0.37, 0.53).g;
      const patches = layer(falls, 0.43, 0.08, 0.6, 0.71, 0.2).b;
      const churn = layer(detail, 1.2, 0.15, 1, 0, 0).b.mul(0.55)
        .add(layer(detail, 2.1, 0.23, 0.7, 0.3, 0.6).b.mul(0.45));
      const inside = bank.y.negate().smoothstep(0.2, 2.4);
      const coverage = steep.mul(mix(float(0.3), float(1), inside))
        .mul(patches.mul(0.7).add(0.55)).clamp(0, 1);
      const thickness = strands.mul(0.6).add(sheets.mul(0.4));
      const dense = thickness.smoothstep(coverage.oneMinus(), coverage.oneMinus().add(0.2));
      const veil = sheets.smoothstep(0.15, 0.85).mul(coverage).mul(0.55);
      // Dense white only right under the drop, breaking into foam patches
      // with dark water between them within a few metres.
      const settle = mix(float(0.66), float(0.4), plunge.pow(1.5).mul(steep.mul(0.6).oneMinus()));
      const boil = churn.smoothstep(settle, settle.add(0.08)).mul(plunge.mul(4).min(1));
      fall.assign(vec3(
        dense.max(veil).max(boil),
        mix(float(1), thickness.smoothstep(0.32, 0.6), steep.mul(inside.oneMinus())),
        mix(churn, strands, steep).mul(0.3).add(0.82),
      ));
    });
    const inlandFoam = Fn(() => {
      const value = float(0).toVar();
      If(body.lessThan(1.5).and(gradientsReady), () => {
        value.assign(riverShore.add(bankFoam).mul(steep.oneMinus()).add(fall.x));
      });
      return value;
    })();
    const foam = inlandFoam.add(onlySea(sharedSurf.add(whitecaps).add(breakers))).clamp(0, 0.94);
    // River foam is a white diffuse scatterer lit by the scene's own sun and
    // sky, like the waterfall mist, so it dims with everything else at night.
    // The plunge churns as white as the fall above it; calmer foam is greener.
    const whitewater = falling.max(plunge.mul(1.5).min(1));
    const foamLight = light.sun.mul(dot(n, uniforms.sunDirection).mul(0.225).add(0.575))
      .add(light.sky.mul(SKY_GAIN));
    const foamColor = mix(
      mix(color('#d6e7db'), color('#e4f5ff'), whitewater).mul(foamLight),
      color('#edf8fb').mul(uniforms.sunStrength.mul(0.7).add(0.2)),
      sea,
    );

    const crestMask = crestHeight.smoothstep(seaArt.crestStart, seaArt.crestEnd).mul(sea);
    const grazing = float(1).sub(facing).pow(1.6);
    const backlit = dot(view, uniforms.sunDirection).negate().smoothstep(-0.15, 0.65);
    const crestTransmission = crestMask.mul(grazing).mul(backlit)
      .mul(uniforms.sunStrength)
      .mul(seaParams.crestTranslucency)
      .mul(seaArt.crestTransmissionStrength);
    const crestColor = mix(
      color(seaPalette.sunny?.shallow ?? '#259eac'),
      uniforms.sunColor,
      0.28,
    ).mul(crestTransmission);

    return vec4(mix(
      mix(underwater, reflected, fresnel.mul(0.85).mul(falling.mul(0.85).oneMinus()))
        .add(glint.mul(falling.mul(0.8).oneMinus()))
        .add(onlySea(crestColor, vec3(0))),
      foamColor.mul(fall.z),
      foam,
    ), fall.y);
  })();

  // Upstream the ribbon ends at the channel edge, fading over the last 0.45 m
  // inside it. At the mouth it reaches on past the edge instead, across the
  // shelving apron the carve left, so the estuary has no outline of its own
  // where it lies on the sea. Dry ground still cuts it off through `depth`.
  const ribbonEdge = mix(
    bank.y.negate().smoothstep(0, 0.45),
    // The sea's own coverage takes over exactly as the ribbon gives way, so the
    // handover is complementary: the two never stack into a tint of their own,
    // and the ribbon does not end on the line where its geometry stops.
    bank.y.smoothstep(0, MOUTH_EDGE_FADE).oneMinus().mul(seaCoverage.oneMinus()),
    mouth,
  );
  material.opacityNode = mix(smoothstep(0.015, 0.15, depth), seaCoverage, sea)
    .mul(mix(float(1), ribbonEdge, current));
  return {
    material,
    uniforms,
    light,
    detail,
    normalNode,
    dispose() {
      material.dispose();
      refraction.dispose();
      detail.dispose();
      falls.dispose();
      if (seaDetail !== detail) seaDetail.dispose();
    },
  };
}
