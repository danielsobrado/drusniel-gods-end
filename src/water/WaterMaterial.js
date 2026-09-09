import * as THREE from 'three/webgpu';
import { Fn, If, Discard, abs, attribute, cameraPosition, color, cos, cubeTexture, dot,
  float, fract, mix, normalize, normalWorld, positionLocal, positionWorld, pow, reflect, screenUV,
  sin, smoothstep, texture, uniform, uniformArray, vec2, vec3, viewportSharedTexture, viewportSafeUV } from 'three/tsl';
import { riverField } from './riverNodes.js';
import { coastXNode } from '../world/coast.js';

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
  const detail = createWaterDetailTexture();
  const uniforms = {
    clock: uniform(0), rain: uniform(0), sunColor: uniform(new THREE.Color('#fff0cc')),
    sunDirection: uniform(new THREE.Vector3(-0.4, 0.8, -0.4)), sunStrength: uniform(1),
    footsteps: uniformArray(Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, -100, 0))),
    rich: uniform(1),
  };
  const t = uniforms.clock;
  const body = attribute('waterKind', 'float');
  const kind = body.greaterThan(0.5).and(body.lessThan(1.5)).select(float(1), float(0));
  const sea = body.greaterThan(1.5).select(float(1), float(0));
  const flowData = attribute('waterFlow', 'vec4');
  const surface = attribute('riverSurface', 'vec4');
  const currentUv = vec2(surface.x.mul(0.22), surface.y.mul(0.045).sub(t.mul(0.28)));
  const level = attribute('waterLevel', 'float');
  const bank = riverField(river).toVar();
  const terrainUv = positionWorld.xz.sub(vec2(terrain.boundsMin.x, terrain.boundsMin.z))
    .div(vec2(terrain.boundsSize.x, terrain.boundsSize.z)).clamp(0, 1);
  const groundY = texture(terrain.texture, terrainUv).r.mul(terrain.maxHeight - terrain.minHeight).add(terrain.minHeight);
  const depth = positionWorld.y.sub(groundY).max(0);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.FrontSide });
  material.name = 'Mountain river, lake and coast';
  const broadWaves = Fn(([p]) => sin(p.x.mul(0.27).add(p.y.mul(0.11)).sub(t.mul(0.72))).mul(0.065)
    .add(sin(p.x.mul(-0.14).add(p.y.mul(0.31)).sub(t.mul(0.49))).mul(0.035)));
  const localWorld = positionLocal.xz.add(vec2(params.position[0], params.position[2]));
  const offshore = localWorld.x.sub(coastXNode(localWorld.y, params.sea?.shoreX ?? 1000));
  const swell = sin(localWorld.x.mul(0.075).add(localWorld.y.mul(0.025)).add(t.mul(1.1))).mul(0.48)
    .add(sin(localWorld.x.mul(0.032).sub(localWorld.y.mul(0.018)).add(t.mul(0.7))).mul(0.3))
    .mul(offshore.smoothstep(-6, 65)).mul(uniforms.rain.mul(0.65).add(1));
  material.positionNode = positionLocal.add(vec3(0, mix(
    broadWaves(positionLocal.xz).mul(kind.mul(level.sub(params.position[1]).smoothstep(0, 2)).mul(-0.5).add(1)), swell, sea), 0));
  const normals = Fn(() => {
    const flow = mix(vec2(0.13, 0.07), vec2(0, 0.2), kind);
    const phase = fract(t.mul(0.09));
    const phaseB = fract(phase.add(0.5));
    const blend = abs(phase.mul(2).sub(1));
    const p = mix(positionWorld.xz.mul(0.065), currentUv, kind);
    const a = texture(detail, p.sub(flow.mul(phase))).rg.mul(2).sub(1);
    const b = texture(detail, p.sub(flow.mul(phaseB))).rg.mul(2).sub(1);
    const micro = texture(detail, p.mul(3.7).add(vec2(t.mul(-0.018), t.mul(0.013)))).rg.mul(2).sub(1);
    const slope = mix(a, b, blend).mul(mix(0.15, 0.16, kind)).add(micro.mul(0.025));
    const acrossNormal = vec3(flowData.y.negate(), 0, flowData.x);
    const downstream = normalize(vec3(flowData.x, surface.z.negate(), flowData.y));
    const riverNormal = acrossNormal.mul(slope.x).add(downstream.mul(slope.y));
    const impacts = vec2(0).toVar();
    for (let i = 0; i < 8; i++) {
      const foot = uniforms.footsteps.element(i);
      const age = t.sub(foot.z).max(0);
      const delta = positionWorld.xz.sub(foot.xy);
      const distance = delta.length().max(0.001);
      const ring = distance.sub(age.mul(2.3));
      const pulse = sin(ring.mul(15)).mul(ring.pow(2).mul(-5).exp()).mul(age.mul(-1.2).exp()).mul(foot.w).mul(0.12);
      impacts.addAssign(delta.div(distance).mul(pulse));
    }
    const rain = sin(positionWorld.xz.mul(17).add(t.mul(7))).mul(0.05).mul(uniforms.rain);
    const seaSlope = cos(positionWorld.x.mul(0.075).add(positionWorld.z.mul(0.025)).add(t.mul(1.1)))
      .mul(0.036).mul(sea).mul(uniforms.rain.mul(0.65).add(1));
    return normalize(normalWorld.add(mix(vec3(slope.x.negate(), 0, slope.y.negate()), riverNormal, kind))
      .add(vec3(impacts.x.add(rain.x).add(seaSlope).negate(), 0, impacts.y.add(rain.y).add(seaSlope.mul(0.33)).negate())));
  });
  const refraction = viewportSharedTexture();
  const cube = cubeTexture(reflection);
  material.colorNode = Fn(() => {
    const riverHere = bank.y.lessThan(0);
    If(body.lessThan(0.5).and(riverHere), () => Discard());
    If(kind.greaterThan(0.5).and(riverHere.not()), () => Discard());
    If(sea.greaterThan(0.5).and(positionWorld.x.lessThan(coastXNode(positionWorld.z, params.sea?.shoreX ?? 1000).sub(180))), () => Discard());
    If(depth.lessThan(0.015), () => Discard());
    const n = normals().toVar();
    const falling = surface.z.smoothstep(0.18, 0.65).mul(kind);
    const view = normalize(cameraPosition.sub(positionWorld));
    const facing = dot(n, view).max(0);
    const fresnel = pow(float(1).sub(facing), 5).mul(0.98).add(0.02);
    const distortion = n.xz.mul(0.014).mul(depth.smoothstep(0, 2));
    const refracted = refraction.sample(viewportSafeUV(screenUV.add(distortion))).rgb;
    const opticalDepth = depth.div(dot(normalWorld, view).abs().max(0.25)).min(28).add(falling.mul(3));
    const transmission = vec3(0.22, 0.085, 0.06).mul(opticalDepth.negate()).exp();
    const waterColor = mix(mix(color('#164e52'), color('#246d70'), uniforms.sunStrength.mul(0.3).clamp(0, 1)),
      color('#0a3856').mul(uniforms.sunStrength.mul(0.6).add(0.25)), sea);
    const underwater = refracted.mul(transmission).add(waterColor.mul(transmission.oneMinus()));
    const direction = reflect(view.negate(), n);
    const probe = cube.sample(direction).rgb;
    const oceanSky = mix(color('#adc9d0'), color('#466f94'), direction.y.smoothstep(0, 0.7))
      .mul(uniforms.sunStrength.mul(0.85).add(0.12));
    let reflected = mix(probe, oceanSky, sea);
    if (planar) {
      // Only the horizontal lake/mouth share this reflection plane.
      const lakeWeight = level.sub(params.position[1]).abs().smoothstep(0.05, 3).oneMinus().mul(uniforms.rich);
      reflected = mix(probe, planar.sample(screenUV.flipX().add(distortion)).rgb, lakeWeight);
    }
    if (seaPlanar) reflected = mix(reflected, mix(oceanSky, seaPlanar.sample(screenUV.flipX().add(distortion)).rgb, uniforms.rich), sea);
    const spec = dot(reflect(uniforms.sunDirection.negate(), n), view).max(0);
    const glint = pow(spec, 170).mul(1.8).add(pow(spec, 20).mul(0.08)).mul(uniforms.sunStrength).mul(uniforms.sunColor);
    const oceanFoamUv = vec2(positionWorld.x.mul(0.055).add(t.mul(0.025)), positionWorld.z.mul(0.048));
    const foamNoise = texture(detail, mix(currentUv, oceanFoamUv, sea)).b;
    const turbulence = flowData.z.sub(0.7).mul(0.34).clamp(0, 0.65).mul(kind);
    const shore = depth.smoothstep(0.02, 0.13).mul(depth.smoothstep(0.22, 0.75).oneMinus());
    const streaks = texture(detail, currentUv.mul(vec2(0.7, 2.4)).add(vec2(0.3, 0.1))).b;
    const coastalDistance = positionWorld.x.sub(coastXNode(positionWorld.z, params.sea?.shoreX ?? 1000));
    const breaker = sin(coastalDistance.mul(0.23).add(t.mul(1.35)).add(foamNoise.mul(1.5))).mul(0.5).add(0.5).smoothstep(0.65, 0.95);
    const surf = breaker.mul(depth.smoothstep(0.05, 0.4)).mul(depth.smoothstep(2, 8).oneMinus()).mul(sea);
    const bankFoam = bank.y.abs().smoothstep(0.1, 1.15).oneMinus().mul(kind)
      .mul(foamNoise.smoothstep(0.3, 0.75)).mul(0.5);
    const cascade = texture(detail, currentUv.mul(vec2(1.8, 1.8))).b.smoothstep(0.24, 0.7)
      .mul(falling).mul(0.8);
    const landing = surface.w.mul(falling.oneMinus()).mul(kind)
      .mul(foamNoise.smoothstep(0.2, 0.65)).mul(0.85);
    const foam = foamNoise.smoothstep(0.48, 0.78).mul(shore.mul(0.6).add(turbulence.mul(streaks.pow(3))))
      .add(surf.mul(foamNoise.mul(0.5).add(0.5))).add(bankFoam).add(cascade).add(landing).clamp(0, 0.94);
    const foamColor = mix(color('#d6e7db').mul(uniforms.sunColor), color('#e4f5ff'), falling)
      .mul(uniforms.sunStrength.mul(0.3).add(0.5));
    return mix(mix(underwater, reflected, fresnel.mul(0.85).mul(falling.mul(0.85).oneMinus()))
      .add(glint.mul(falling.mul(0.8).oneMinus())), foamColor, foam);
  })();
  material.opacityNode = smoothstep(0.015, 0.15, depth)
    .mul(mix(float(1), bank.y.negate().smoothstep(0, 0.45), kind));
  return { material, uniforms, detail, dispose() { material.dispose(); detail.dispose(); } };
}
