import * as THREE from 'three/webgpu';
import { WaterRefractionNode } from './WaterRefractionNode.js';
import { Fn, If, Discard, abs, attribute, cameraPosition, color, cubeTexture, dot,
  float, fract, mix, normalize, normalWorld, positionLocal, positionWorld, pow, reflect, screenUV,
  sin, smoothstep, texture, uniform, uniformArray, vec2, vec3, nodeObject, viewportSafeUV } from 'three/tsl';
import { riverField } from './riverNodes.js';
import { coastXNode } from '../world/coast.js';
import { createSeaNodes } from './seaNodes.js';
import { createSeaDetailTexture } from './seaDetail.js';

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
    return THREE.MathUtils.lerp(THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), sx),
      THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), sx), sy);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size * Math.PI * 2, v = y / size * Math.PI * 2;
    const dx = Math.cos(u * 3 + v * 4 + Math.sin(v * 2)) * 0.28 + Math.cos(u * 5 - v * 2) * 0.19
      + Math.cos(u * 7 + v * 9 + Math.sin(u * 3)) * 0.09 + Math.cos(u * 13 - v * 7) * 0.05;
    const dz = Math.cos(u * 3 + v * 4 + Math.sin(v * 2)) * 0.24 - Math.cos(u * 5 - v * 2) * 0.12
      + Math.cos(u * 7 + v * 9 + Math.sin(u * 3)) * 0.13 - Math.cos(u * 13 - v * 7) * 0.03;
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

export function createCinematicWaterMaterial({ terrain, river, params, reflection, planar, seaPlanar }) {
  const seaPalette = params.sea?.colors ?? {};
  const detail = createWaterDetailTexture();
  const seaDetail = params.sea?.enabled ? createSeaDetailTexture(params.sea.choppiness) : detail;
  const uniforms = {
    clock: uniform(0), rain: uniform(0), sunColor: uniform(new THREE.Color('#fff0cc')),
    sunDirection: uniform(new THREE.Vector3(-0.4, 0.8, -0.4)), sunStrength: uniform(1),
    footsteps: uniformArray(Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, -100, 0))),
    rich: uniform(1), seaDetail: uniform(1),
  };
  const t = uniforms.clock;
  const body = attribute('waterKind', 'float');
  const kind = body.greaterThan(0.5).and(body.lessThan(1.5)).select(float(1), float(0));
  const sea = body.greaterThan(1.5).select(float(1), float(0));
  const ocean = createSeaNodes(params.sea, t, uniforms.rain);
  const flowData = attribute('waterFlow', 'vec4');
  const surface = attribute('riverSurface', 'vec4');
  const currentUv = vec2(surface.x.mul(0.22), surface.y.mul(0.045).sub(t.mul(0.28)));
  const level = attribute('waterLevel', 'float');
  const lakeHere = positionWorld.x.sub(params.position[0]).abs().lessThan(params.size / 2)
    .and(positionWorld.z.sub(params.position[2]).abs().lessThan(params.size / 2));
  // Lose the channel's directional ripples as it settles to lake level. At the
  // mouth both meshes must sample exactly the same world-space detail.
  const current = kind.mul(lakeHere.select(level.sub(params.position[1]).smoothstep(0, 2), float(1)));
  const detailUv = mix(positionWorld.xz.mul(0.065), currentUv, current);
  const bank = riverField(river).toVar();
  const terrainUv = positionWorld.xz.sub(vec2(terrain.boundsMin.x, terrain.boundsMin.z))
    .div(vec2(terrain.boundsSize.x, terrain.boundsSize.z)).clamp(0, 1);
  const groundY = texture(terrain.texture, terrainUv).r.mul(terrain.maxHeight - terrain.minHeight).add(terrain.minHeight);
  // The analytic sea shelf continues outside the terrain height texture. Its
  // zero-depth waterline agrees with the terrain's shared coast profile.
  const oceanDepth = ocean.depth(positionWorld.xz).add(positionWorld.y.sub(params.sea?.level ?? -24));
  const depth = mix(positionWorld.y.sub(groundY), oceanDepth, sea).max(0);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.FrontSide });
  material.name = 'Mountain river, lake and coast';
  const broadWaves = Fn(([p]) => sin(p.x.mul(0.27).add(p.y.mul(0.11)).sub(t.mul(0.72))).mul(0.065)
    .add(sin(p.x.mul(-0.14).add(p.y.mul(0.31)).sub(t.mul(0.49))).mul(0.035)));
  const localWorld = positionLocal.xz.add(vec2(params.position[0], params.position[2]));
  material.positionNode = Fn(() => {
    const displacement = float(0).toVar();
    If(body.greaterThan(1.5), () => { displacement.assign(ocean.height(localWorld)); })
      .Else(() => { displacement.assign(broadWaves(positionLocal.xz)
        .mul(kind.mul(level.sub(params.position[1]).smoothstep(0, 2)).mul(-0.5).add(1))); });
    return positionLocal.add(vec3(0, displacement, 0));
  })();
  const normals = Fn(() => {
    const flow = mix(vec2(0.13, 0.07), vec2(0, 0.2), current);
    const phase = fract(t.mul(0.09));
    const phaseB = fract(phase.add(0.5));
    const blend = abs(phase.mul(2).sub(1));
    const p = detailUv;
    const a = texture(detail, p.sub(flow.mul(phase))).rg.mul(2).sub(1);
    const b = texture(detail, p.sub(flow.mul(phaseB))).rg.mul(2).sub(1);
    const micro = texture(detail, p.mul(3.7).add(vec2(t.mul(-0.018), t.mul(0.013)))).rg.mul(2).sub(1);
    const seaFade = cameraPosition.distance(positionWorld).smoothstep(35, 300).oneMinus();
    const seaStrength = mix(float(0.07), float(0.3), ocean.offshore(positionWorld.xz));
    const detailFade = mix(float(1), seaFade.mul(uniforms.seaDetail), sea);
    const slope = mix(a, b, blend).mul(mix(mix(0.15, 0.16, current), seaStrength, sea))
      .add(micro.mul(mix(float(0.025), float(0.075), sea))).mul(detailFade).toVar();
    If(body.greaterThan(1.5), () => {
      const oceanUv = positionWorld.xz.mul(1 / 32);
      const first = texture(seaDetail, oceanUv.add(vec2(t.mul(0.008), t.mul(0.003)))).rg.mul(2).sub(1);
      const second = texture(seaDetail, oceanUv.mul(1.73).add(vec2(t.mul(-0.006), t.mul(0.005)))).rg.mul(2).sub(1);
      const fine = texture(seaDetail, oceanUv.mul(5.7).add(vec2(t.mul(0.005), t.mul(-0.004)))).rg.mul(2).sub(1);
      slope.assign(first.mul(0.65).add(second.mul(0.35)).add(fine.mul(0.15))
        .mul(mix(float(0.16), float(0.8), ocean.offshore(positionWorld.xz))).mul(detailFade).mul(uniforms.rain.mul(0.35).add(1)));
    });
    const acrossNormal = vec3(flowData.y.negate(), 0, flowData.x);
    // Lake/sea flow attributes are zero. normalize(0) poisons mix(..., 0)
    // with NaNs on some drivers, wiping out every ocean normal and reflection.
    const flowVector = vec3(flowData.x, surface.z.negate(), flowData.y);
    const downstream = flowVector.div(flowVector.length().max(0.0001));
    const riverNormal = acrossNormal.mul(slope.x).add(downstream.mul(slope.y));
    const impacts = vec2(0).toVar();
    for (let i = 0; i < 8; i++) {
      const foot = uniforms.footsteps.element(i);
      const age = t.sub(foot.z).max(0);
      const delta = positionWorld.xz.sub(foot.xy);
      const distance = delta.length().max(0.001);
      const ring = distance.sub(age.mul(2.3));
      const pulse = sin(ring.mul(15)).mul(ring.mul(ring).mul(-5).exp()).mul(age.mul(-1.2).exp()).mul(foot.w).mul(0.12);
      impacts.addAssign(delta.div(distance).mul(pulse));
    }
    const rain = sin(positionWorld.xz.mul(17).add(t.mul(7))).mul(0.05).mul(uniforms.rain);
    const base = normalWorld.toVar();
    If(body.greaterThan(1.5), () => { base.assign(ocean.normal(positionWorld.xz)); });
    return normalize(base.add(mix(vec3(slope.x.negate(), 0, slope.y.negate()), riverNormal, current))
      .add(vec3(impacts.x.add(rain.x).negate(), 0, impacts.y.add(rain.y).negate())));
  });
  const refraction = nodeObject(new WaterRefractionNode());
  const cube = cubeTexture(reflection);
  const normalNode = normals();
  material.colorNode = Fn(() => {
    // Let the lake grid own the level mouth: independently tessellated waves
    // otherwise leave hairline cracks even with identical shading and phase.
    // A flat river outside the lake footprint still needs its own ribbon.
    const riverHere = bank.y.lessThan(0).and(bank.x.greaterThan(params.position[1]).or(lakeHere.not()));
    If(body.lessThan(0.5).and(riverHere), () => Discard());
    If(kind.greaterThan(0.5).and(riverHere.not()), () => Discard());
    If(sea.greaterThan(0.5).and(positionWorld.x.lessThan(coastXNode(positionWorld.z, params.sea?.shoreX ?? 1000).sub(180))), () => Discard());
    If(depth.lessThan(0.015), () => Discard());
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
    const seaColor = mix(mix(color(seaPalette.sunny?.shallow ?? '#259eac'), color(seaPalette.storm?.shallow ?? '#176662'), uniforms.rain),
      mix(color(seaPalette.sunny?.deep ?? '#073c58'), color(seaPalette.storm?.deep ?? '#032d48'), uniforms.rain), ocean.depth(positionWorld.xz).smoothstep(2, 24))
      .mul(uniforms.sunStrength.mul(0.75).add(0.25));
    const waterColor = mix(mix(color('#164e52'), color('#246d70'), uniforms.sunStrength.mul(0.3).clamp(0, 1)), seaColor, sea);
    const underwater = refracted.mul(transmission).add(waterColor.mul(transmission.oneMinus()));
    const direction = reflect(view.negate(), n);
    const probe = cube.sample(direction).rgb;
    const oceanSky = mix(color('#81a8b4'), color('#38658a'), direction.y.smoothstep(0, 0.7))
      .mul(uniforms.sunStrength.mul(0.85).add(0.12));
    let reflected = mix(probe, oceanSky, sea);
    if (planar) {
      // Only the horizontal lake/mouth share this reflection plane.
      const lakeWeight = level.sub(params.position[1]).abs().smoothstep(0.05, 3).oneMinus().mul(uniforms.rich);
      reflected = mix(probe, planar.sample(screenUV.flipX().add(distortion)).rgb, lakeWeight);
    }
    if (seaPlanar) reflected = mix(reflected, mix(oceanSky,
      seaPlanar.sample(screenUV.flipX().add(distortion)).rgb, uniforms.rich.mul(0.65)), sea);
    const spec = dot(reflect(uniforms.sunDirection.negate(), n), view).max(0);
    const glint = pow(spec, 170).mul(1.8).add(pow(spec, 20).mul(0.08)).mul(uniforms.sunStrength).mul(uniforms.sunColor);
    const oceanFoamUv = vec2(positionWorld.x.mul(0.055).add(t.mul(0.025)), positionWorld.z.mul(0.048));
    const foamNoise = texture(detail, mix(detailUv, oceanFoamUv, sea)).b;
    const turbulence = flowData.z.sub(0.7).mul(0.34).clamp(0, 0.65).mul(current);
    const shore = depth.smoothstep(0.02, 0.13).mul(depth.smoothstep(0.22, 0.75).oneMinus());
    const streaks = texture(detail, currentUv.mul(vec2(0.7, 2.4)).add(vec2(0.3, 0.1))).b;
    const phase = ocean.beachPhase(positionWorld.xz);
    const crest = sin(phase).smoothstep(mix(0.78, 0.35, uniforms.rain), 0.98);
    const age = fract(phase.sub(Math.PI / 2).div(Math.PI * 2));
    const wash = age.smoothstep(0, 0.035).mul(age.mul(mix(-9, -4, uniforms.rain)).exp());
    const foamBreakup = texture(detail, positionWorld.xz.mul(0.18).add(vec2(t.mul(0.035), 0))).b;
    const breakup = foamNoise.mul(0.65).add(foamBreakup.mul(0.35)).smoothstep(mix(0.32, 0.18, uniforms.rain), 0.67);
    const surf = crest.mul(mix(0.68, 0.9, uniforms.rain)).add(wash.mul(mix(0.3, 0.7, uniforms.rain))).mul(breakup)
      .mul(ocean.depth(positionWorld.xz).smoothstep(0.08, 0.45))
      .mul(ocean.depth(positionWorld.xz).smoothstep(2, 7).oneMinus()).mul(sea);
    const bankFoam = bank.y.abs().smoothstep(0.1, 1.15).oneMinus().mul(current)
      .mul(foamNoise.smoothstep(0.3, 0.75)).mul(0.5);
    const cascade = texture(detail, currentUv.mul(vec2(1.8, 1.8))).b.smoothstep(0.24, 0.7)
      .mul(falling).mul(0.8);
    const landing = surface.w.mul(falling.oneMinus()).mul(current)
      .mul(foamNoise.smoothstep(0.2, 0.65)).mul(0.85);
    const foam = foamNoise.smoothstep(0.48, 0.78).mul(shore.mul(0.6).add(turbulence.mul(streaks.pow(3))))
      .add(surf).add(bankFoam).add(cascade).add(landing).clamp(0, 0.94);
    const foamColor = mix(mix(color('#d6e7db').mul(uniforms.sunColor), color('#e4f5ff'), falling)
      .mul(uniforms.sunStrength.mul(0.3).add(0.5)), color('#edf8fb').mul(uniforms.sunStrength.mul(0.7).add(0.2)), sea);
    const crestLight = positionWorld.y.sub(params.sea?.level ?? -24).max(0).mul(0.075)
      .mul(dot(n, uniforms.sunDirection).max(0)).mul(uniforms.sunStrength).mul(sea);
    return mix(mix(underwater, reflected, fresnel.mul(0.85).mul(falling.mul(0.85).oneMinus()))
      .add(glint.mul(falling.mul(0.8).oneMinus())).add(color('#65b7bb').mul(crestLight)), foamColor, foam);
  })();
  material.opacityNode = smoothstep(0.015, 0.15, depth)
    // Only a raised channel has banks here. Fading the lake-level ribbon's
    // edge exposes the bed because the lake is masked out beneath it.
    .mul(mix(float(1), bank.y.negate().smoothstep(0, 0.45), current));
  return { material, uniforms, detail, normalNode, dispose() {
    material.dispose(); refraction.dispose(); detail.dispose(); if (seaDetail !== detail) seaDetail.dispose();
  } };
}
