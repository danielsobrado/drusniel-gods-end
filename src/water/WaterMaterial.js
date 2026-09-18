import * as THREE from 'three/webgpu';
import { WaterRefractionNode } from './WaterRefractionNode.js';
import {
  Discard,
  Fn,
  If,
  abs,
  attribute,
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
  viewportSafeUV,
} from 'three/tsl';
import { riverField } from './riverNodes.js';
import { createSeaNodes } from './seaNodes.js';
import {
  createSeaDetailTexture,
  SEA_DETAIL_MOMENT_SCALE,
  SEA_DETAIL_SLOPE_RANGE,
} from './seaDetail.js';

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
  skyColorProvider = null,
  snowAltitude = null,
}) {
  const seaPalette = params.sea?.colors ?? {};
  const detail = createWaterDetailTexture();
  const seaDetail = params.sea?.enabled ? createSeaDetailTexture(params.sea.choppiness) : detail;
  const uniforms = {
    clock: uniform(0),
    rain: uniform(0),
    sunColor: uniform(new THREE.Color('#fff0cc')),
    sunDirection: uniform(new THREE.Vector3(-0.4, 0.8, -0.4)),
    sunStrength: uniform(1),
    footsteps: uniformArray(Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, -100, 0))),
    rich: uniform(1),
    seaDetail: uniform(1),
  };
  const t = uniforms.clock;
  const body = attribute('waterKind', 'float');
  const kind = body.greaterThan(0.5).and(body.lessThan(1.5)).select(float(1), float(0));
  const sea = body.greaterThan(1.5).select(float(1), float(0));
  const ocean = createSeaNodes(params.sea, t, uniforms.rain);
  const seaParams = ocean.params;
  const seaArt = seaParams.detail;
  const flowData = attribute('waterFlow', 'vec4');
  const surface = attribute('riverSurface', 'vec4');
  const currentUv = vec2(surface.x.mul(0.22), surface.y.mul(0.045).sub(t.mul(0.28)));
  const level = attribute('waterLevel', 'float');
  const lakeHere = positionWorld.x.sub(params.position[0]).abs().lessThan(params.size / 2)
    .and(positionWorld.z.sub(params.position[2]).abs().lessThan(params.size / 2));
  const current = kind.mul(lakeHere.select(level.sub(params.position[1]).smoothstep(0, 2), float(1)));
  // Snowmelt: up in snow country the river runs cold and dark, and reflects
  // the sky it runs under rather than the meadow probe captured down at the
  // lake.
  const alpine = snowAltitude
    ? level.smoothstep(snowAltitude.start, snowAltitude.full).mul(kind).toVar()
    : float(0);
  const detailUv = mix(positionWorld.xz.mul(0.065), currentUv, current);
  const bank = riverField(river).toVar();
  const terrainUv = positionWorld.xz.sub(vec2(terrain.boundsMin.x, terrain.boundsMin.z))
    .div(vec2(terrain.boundsSize.x, terrain.boundsSize.z)).clamp(0, 1);
  const groundY = texture(terrain.texture, terrainUv).r
    .mul(terrain.maxHeight - terrain.minHeight).add(terrain.minHeight);
  const oceanDepth = ocean.depth(positionWorld.xz).add(positionWorld.y.sub(seaParams.level));
  const depth = mix(positionWorld.y.sub(groundY), oceanDepth, sea).max(0);
  // This is the CoastField-owned mean-depth handoff. GroundMaterial uses its
  // complement, so swash film and sea opacity meet without a shoreline cut.
  const seaCoverage = ocean.seaCoverage(positionWorld.xz);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  material.name = 'Mountain river, lake and coast';

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
  // Force explicit texture gradients into uniform control flow before any
  // per-body or distance branch. Body attributes are constant per triangle.
  const gradientsReady = worldDx.x.equal(worldDx.x).and(worldDy.x.equal(worldDy.x))
    .and(detailDx.x.equal(detailDx.x)).and(detailDy.x.equal(detailDy.x))
    .and(flowDx.x.equal(flowDx.x)).and(flowDy.x.equal(flowDy.x))
    .and(currentDx.x.equal(currentDx.x)).and(currentDy.x.equal(currentDy.x));
  const oceanSample = (uv, scale = 1) => texture(seaDetail, uv)
    .grad(worldDx.mul(scale / seaArt.textureWorldScale), worldDy.mul(scale / seaArt.textureWorldScale));
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
        .mul(uniforms.seaDetail);
      const oceanUv = positionWorld.xz.mul(1 / seaArt.textureWorldScale);
      If(mediumFade.greaterThan(0), () => {
        const first = oceanSample(oceanUv.add(vec2(t.mul(seaArt.primaryScrollX), t.mul(seaArt.primaryScrollZ)))).rg
          .mul(2).sub(1).mul(SEA_DETAIL_SLOPE_RANGE);
        const second = oceanSample(oceanUv.mul(seaArt.mediumScale)
          .add(vec2(t.mul(seaArt.secondaryScrollX), t.mul(seaArt.secondaryScrollZ))), seaArt.mediumScale).rg
          .mul(2).sub(1).mul(SEA_DETAIL_SLOPE_RANGE);
        slope.assign(first.mul(seaArt.primaryWeight).add(second.mul(seaArt.secondaryWeight)).mul(mediumFade));
      });
      If(fineFade.greaterThan(0), () => {
        const fine = oceanSample(oceanUv.mul(seaArt.fineScale)
          .add(vec2(t.mul(seaArt.fineScrollX), t.mul(seaArt.fineScrollZ))), seaArt.fineScale).rg
          .mul(2).sub(1).mul(SEA_DETAIL_SLOPE_RANGE);
        slope.addAssign(fine.mul(seaArt.fineStrength).mul(fineFade));
      });
      const offshoreStrength = mix(float(0.16), float(seaArt.mediumStrength), ocean.offshore(positionWorld.xz));
      slope.mulAssign(offshoreStrength.mul(seaParams.detailStrength)
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
    If(body.greaterThan(1.5), () => {
      base.assign(ocean.normal(positionWorld.xz));
    });
    return normalize(base
      .add(mix(vec3(slope.x.negate(), 0, slope.y.negate()), riverNormal, current))
      .add(vec3(impacts.x.add(rain.x).negate(), 0, impacts.y.add(rain.y).negate())));
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
    const fresnel = pow(float(1).sub(facing), mix(float(5), float(3), sea))
      .mul(mix(float(0.98), float(0.96), sea)).add(mix(float(0.02), float(0.04), sea));
    const distortion = n.xz.mul(0.014).mul(depth.smoothstep(0, 2));
    const refracted = refraction.sample(viewportSafeUV(screenUV.add(distortion))).rgb;
    const opticalDepth = depth.div(dot(normalWorld, view).abs().max(0.25))
      .min(mix(float(28), float(120), sea)).add(falling.mul(3));
    const transmission = vec3(0.22, 0.085, 0.06).mul(opticalDepth.negate()).exp();
    const seaColor = mix(
      mix(color(seaPalette.sunny?.shallow ?? '#259eac'), color(seaPalette.storm?.shallow ?? '#176662'), uniforms.rain),
      mix(color(seaPalette.sunny?.deep ?? '#073c58'), color(seaPalette.storm?.deep ?? '#032d48'), uniforms.rain),
      ocean.depth(positionWorld.xz).smoothstep(2, 24),
    ).mul(uniforms.sunStrength.mul(0.75).add(0.25));
    const inlandColor = mix(color('#164e52'), color('#246d70'), uniforms.sunStrength.mul(0.3).clamp(0, 1));
    const waterColor = mix(
      mix(inlandColor, color('#10303d'), alpine),
      seaColor,
      sea,
    );
    const underwater = refracted.mul(transmission).add(waterColor.mul(transmission.oneMinus()));
    const direction = reflect(view.negate(), n);
    const probe = cube.sample(direction).rgb;
    const fallbackSky = mix(color('#81a8b4'), color('#38658a'), direction.y.smoothstep(0, 0.7))
      .mul(uniforms.sunStrength.mul(0.85).add(0.12));
    const oceanSky = skyColorProvider ? skyColorProvider(direction) : fallbackSky;
    const reflected = mix(probe, oceanSky, skyColorProvider ? sea.max(alpine) : sea).toVar();

    if (planar) {
      const lakeWeight = level.sub(params.position[1]).abs().smoothstep(0.05, 3).oneMinus().mul(uniforms.rich);
      If(uniforms.rich.greaterThan(0.5), () => {
        reflected.assign(mix(probe, planar.sample(screenUV.flipX().add(distortion)).rgb, lakeWeight));
      });
    }
    if (seaPlanar) If(uniforms.rich.greaterThan(0.5), () => {
      reflected.assign(mix(
        reflected,
        mix(oceanSky, seaPlanar.sample(screenUV.flipX().add(distortion)).rgb, 0.65),
        sea,
      ));
    });

    const oceanUv = positionWorld.xz.mul(1 / seaArt.textureWorldScale)
      .add(vec2(t.mul(seaArt.primaryScrollX), t.mul(seaArt.primaryScrollZ)));
    const momentSample = oceanSample(oceanUv);
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
    const riverShore = foamNoise.smoothstep(0.48, 0.78)
      .mul(shore.mul(0.6).add(turbulence.mul(streaks.pow(3))))
      .mul(sea.oneMinus());

    const sharedSurf = ocean.foamFront(positionWorld.xz)
      .mul(ocean.offshore(positionWorld.xz).oneMinus())
      .mul(ocean.depth(positionWorld.xz).smoothstep(seaArt.surfDepthStart, seaArt.surfDepthEnd))
      .mul(ocean.depth(positionWorld.xz).smoothstep(seaArt.surfFadeStart, seaArt.surfFadeEnd).oneMinus())
      .mul(sea);
    const crestThreshold = mix(
      float(seaArt.whitecapThreshold),
      float(seaArt.stormWhitecapThreshold),
      uniforms.rain,
    );
    const crest = ocean.crest(positionWorld.xz).smoothstep(crestThreshold, 0.98);
    const steepness = float(1).sub(ocean.normal(positionWorld.xz).y)
      .smoothstep(seaArt.whitecapSteepness * 0.55, seaArt.whitecapSteepness);
    const whitecapBreakup = momentSample.b.mul(0.65)
      .add(oceanSample(oceanUv.mul(1.79).sub(vec2(t.mul(seaArt.foamPersistence), 0)), 1.79).b.mul(0.35))
      .smoothstep(seaArt.foamBreakupLow, seaArt.foamBreakupHigh);
    const whitecaps = crest.mul(seaArt.whitecapCrestWeight).add(steepness.mul(seaArt.whitecapSteepnessWeight)).clamp(0, 1)
      .mul(whitecapBreakup)
      .mul(ocean.offshore(positionWorld.xz))
      .mul(seaParams.whitecapStrength)
      .mul(uniforms.rain.mul(seaArt.whitecapRainBoost).add(seaArt.whitecapRainBase))
      .mul(sea);

    const bankFoam = bank.y.abs().smoothstep(0.1, 1.15).oneMinus().mul(current)
      .mul(foamNoise.smoothstep(0.3, 0.75)).mul(0.5);
    const cascade = texture(detail, currentUv.mul(vec2(1.8, 1.8)))
      .grad(currentDx.mul(1.8), currentDy.mul(1.8)).b.smoothstep(0.24, 0.7)
      .mul(falling).mul(0.8);
    const landing = surface.w.mul(falling.oneMinus()).mul(current)
      .mul(foamNoise.smoothstep(0.2, 0.65)).mul(0.85);
    const inlandFoam = Fn(() => {
      const value = float(0).toVar();
      If(body.lessThan(1.5).and(gradientsReady), () => {
        value.assign(riverShore.add(bankFoam).add(cascade).add(landing));
      });
      return value;
    })();
    const foam = inlandFoam.add(onlySea(sharedSurf.add(whitecaps))).clamp(0, 0.94);
    const foamColor = mix(
      mix(color('#d6e7db').mul(uniforms.sunColor), color('#e4f5ff'), falling)
        .mul(uniforms.sunStrength.mul(0.3).add(0.5)),
      color('#edf8fb').mul(uniforms.sunStrength.mul(0.7).add(0.2)),
      sea,
    );

    const crestMask = ocean.crest(positionWorld.xz).smoothstep(seaArt.crestStart, seaArt.crestEnd).mul(sea);
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

    return mix(
      mix(underwater, reflected, fresnel.mul(0.85).mul(falling.mul(0.85).oneMinus()))
        .add(glint.mul(falling.mul(0.8).oneMinus()))
        .add(onlySea(crestColor, vec3(0))),
      foamColor,
      foam,
    );
  })();

  material.opacityNode = mix(smoothstep(0.015, 0.15, depth), seaCoverage, sea)
    .mul(mix(float(1), bank.y.negate().smoothstep(0, 0.45), current));
  return {
    material,
    uniforms,
    detail,
    normalNode,
    dispose() {
      material.dispose();
      refraction.dispose();
      detail.dispose();
      if (seaDetail !== detail) seaDetail.dispose();
    },
  };
}
