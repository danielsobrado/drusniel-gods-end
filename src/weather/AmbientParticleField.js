import * as THREE from 'three/webgpu';
import {
  abs, atan, cameraPosition, cameraWorldMatrix, color, cos, cross, dot, exp, float, floor, fract, hash, instanceIndex,
  max, mix, normalize, positionGeometry, positionWorld, sin, smoothstep, texture, time, uniform, uv, vec2, vec3,
} from 'three/tsl';
import { adoptInstanceMatrices } from '../rendering/instanceMatrices.js';
import { SKY_GAIN } from '../water/sceneLight.js';
import { noise2 } from '../world/snowNoiseNodes.js';
import { createRegionMaskNode } from './ambientRegions.js';

const TWO_PI = Math.PI * 2;
// Below this a field is not drawn at all.
export const FIELD_VISIBILITY_THRESHOLD = 0.004;
// Particles whose weight falls below this collapse to a point, so masked-out
// particles cost vertex work only.
const PARTICLE_CUTOFF = 0.003;
// Fraction of the half-area over which particles fade before they wrap to
// the far side of the field.
const EDGE_FADE_START = 0.36;
const HASH_OFFSETS = Object.freeze({
  x: 11.31, z: 57.17, y: 23.93, size: 91.71, phase: 131.07, speed: 171.39, tone: 211.53, variant: 251.9,
  jitterX: 293.1, jitterY: 331.7, jitterZ: 373.3, blink: 419.9,
});
// Cornette-Shanks forward-scatter asymmetry, as the snow powder and mist use.
const MIE_G = 0.6;
// Sunlight a particle takes regardless of the view: lit from every side, it
// sits closer to a sunlit surface than a single diffuse facet would.
const SUN_BASE = 0.75;

function cornetteShanks(mu) {
  const g2 = MIE_G * MIE_G;
  return mu.mul(mu).add(1).mul((3 / (8 * Math.PI)) * (1 - g2) / (2 + g2))
    .div(mu.mul(-2 * MIE_G).add(1 + g2).pow(1.5));
}

function shapeAlpha(shape, local, seed, puffTexture) {
  const r2 = dot(local, local);
  const r = r2.sqrt();
  const disc = smoothstep(0.75, 1, r).oneMinus();
  switch (shape) {
    case 'glint': {
      // A pinpoint with a faint four-point flare, like ice catching the sun.
      const core = exp(r2.mul(-26));
      const flare = exp(abs(local.x).mul(-9)).mul(exp(local.y.mul(local.y).mul(-160)))
        .add(exp(abs(local.y).mul(-9)).mul(exp(local.x.mul(local.x).mul(-160))));
      return core.add(flare.mul(0.45)).mul(disc);
    }
    case 'streak': {
      // Stretched along the wind (local.x); the leading end is the densest.
      const along = abs(local.x);
      const body = smoothstep(0.25, 1, along).oneMinus().mul(exp(local.y.mul(local.y).mul(-5)));
      return body.mul(mix(float(0.45), float(1), local.x.mul(0.5).add(0.5)));
    }
    case 'firefly':
      return exp(r2.mul(-34)).add(exp(r2.mul(-5)).mul(0.28)).mul(disc);
    case 'fluff': {
      // A seed head: a small core and fine radial filaments.
      const angle = atan(local.y, local.x);
      const spokes = abs(cos(angle.mul(9).add(seed.mul(TWO_PI)))).pow(24);
      return exp(r2.mul(-60)).add(spokes.mul(r.oneMinus().max(0)).mul(0.55))
        .add(exp(r2.mul(-3)).mul(0.12)).mul(disc);
    }
    case 'shaft': {
      // local.x across the beam, local.y along it (from the ground up).
      const across = exp(local.x.mul(local.x).mul(-7));
      const ends = smoothstep(-1, -0.35, local.y).mul(smoothstep(0.2, 1, local.y).oneMinus());
      const dust = noise2(vec2(local.x.mul(1.6), local.y.mul(5).sub(time.mul(0.12))).add(seed.mul(40)))
        .mul(0.5).add(0.75).clamp(0.25, 1.25);
      return across.mul(ends).mul(dust);
    }
    case 'puff': {
      if (!puffTexture) return exp(r2.mul(-3.5)).mul(disc);
      const sample = texture(puffTexture, uv());
      const variant = floor(seed.mul(4));
      return variant.lessThan(1).select(sample.r, variant.lessThan(2).select(sample.g,
        variant.lessThan(3).select(sample.b, sample.a)));
    }
    default:
      // 'soft': a round mote.
      return exp(r2.mul(-4.5)).mul(disc);
  }
}

/**
 * One ambient particle population, drawn in a single instanced call and
 * animated entirely on the GPU from the instance index and time, the same way
 * SnowfallSystem is. The particles tile the world around the focus: each has
 * a fixed place on a toroidal grid `area` metres wide that the wind slides
 * along, so they stay put in the world while the player walks through them,
 * and fade out near the field's edge before wrapping to the other side.
 *
 * `settings` is one resolved entry of ambientEffects.fields; `regions` the
 * resolved ambient regions; `terrain` the TerrainSampler shader data; `light`
 * a createSceneLight() set; `sun` the normalised sun direction uniform.
 */
export class AmbientParticleField {
  constructor({ name, settings, regions, terrain, light, sun, puffTexture = null }) {
    this.name = name;
    this.settings = settings;
    this.intensity = uniform(0);
    this.current = 0;
    this.center = uniform(new THREE.Vector3());
    // fract((drift - center) / area + 0.5), computed in doubles on the CPU.
    this.wrap = uniform(new THREE.Vector2());
    this.windAxis = uniform(new THREE.Vector3(1, 0, 0));
    this.drift = { x: 0, z: 0 };
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.material = this.#createMaterial({ regions, terrain, light, sun, puffTexture });
    this.mesh = adoptInstanceMatrices(new THREE.InstancedMesh(this.geometry, this.material, settings.count));
    this.mesh.name = `Ambient ${name}`;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.userData.excludeFromReflection = true;
    this.mesh.userData.occlusionCull = false;
    // Every particle is placed by positionNode; the instance transform only
    // has to be identity (three allocates it zeroed).
    const identity = new THREE.Matrix4();
    for (let index = 0; index < settings.count; index += 1) this.mesh.setMatrixAt(index, identity);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  #createMaterial({ regions, terrain, light, sun, puffTexture }) {
    const s = this.settings;
    const index = instanceIndex.toFloat();
    // Swarms share their placement; each member jitters around it.
    const group = s.swarm ? floor(index.div(s.swarm.members)) : index;
    const random = (key, source = index) => hash(source.add(HASH_OFFSETS[key]));
    const seedPhase = random('phase');
    const seedSpeed = random('speed');

    const area = float(s.area);
    const relX = fract(random('x', group).add(this.wrap.x)).sub(0.5);
    const relZ = fract(random('z', group).add(this.wrap.y)).sub(0.5);
    const edge = max(abs(relX), abs(relZ)).mul(2);
    const edgeFade = smoothstep(EDGE_FADE_START * 2, 1, edge).oneMinus();

    // Slow wander, on its own phase per particle so they never move as a lattice.
    const wanderRate = time.mul(s.wander.frequency).mul(seedSpeed.mul(0.6).add(0.7));
    let x = this.center.x.add(relX.mul(area)).add(sin(wanderRate.add(seedPhase.mul(TWO_PI))).mul(s.wander.radius));
    let z = this.center.z.add(relZ.mul(area))
      .add(cos(wanderRate.mul(0.83).add(seedPhase.mul(TWO_PI * 1.7))).mul(s.wander.radius));
    let jitterY = float(0);
    if (s.swarm) {
      const jitterRate = time.mul(s.swarm.frequency);
      const spread = float(s.swarm.radius);
      x = x.add(sin(jitterRate.mul(random('jitterX').add(0.6)).add(random('jitterZ').mul(TWO_PI))).mul(spread)
        .mul(random('jitterY').mul(0.7).add(0.3)));
      z = z.add(cos(jitterRate.mul(random('jitterZ').add(0.55)).add(random('jitterX').mul(TWO_PI))).mul(spread)
        .mul(random('jitterX').mul(0.7).add(0.3)));
      jitterY = sin(jitterRate.mul(random('jitterY').add(0.8)).add(seedPhase.mul(TWO_PI))).mul(s.swarm.radius * 0.6);
    }

    // Saltation: blown snow and sand do not glide as one sheet. Each grain
    // skips downwind in its own short arc, at its own speed and a slightly
    // different heading, lands and is lifted again, most of them close to
    // the ground.
    let particleAxis = this.windAxis;
    let hopArc = null;
    let hopFade = float(1);
    if (s.hop) {
      const heading = random('variant').sub(0.5).mul(s.hop.spread * Math.PI / 180);
      const c = cos(heading);
      const n = sin(heading);
      const flat = vec3(this.windAxis.x.mul(c).sub(this.windAxis.z.mul(n)), 0, this.windAxis.x.mul(n).add(this.windAxis.z.mul(c)));
      const phase = fract(time.mul(mix(float(0.6), float(1.5), seedSpeed).mul(s.hop.rate)).add(seedPhase));
      const hopLength = mix(float(0.5), float(1.4), random('tone')).mul(s.hop.length);
      const along = phase.sub(0.5).mul(hopLength);
      x = x.add(flat.x.mul(along));
      z = z.add(flat.z.mul(along));
      // Skewed low: a few grains fly high, most skim the surface.
      const peak = random('y', group).pow(3).mul(s.height[1] - s.height[0]);
      hopArc = sin(phase.mul(Math.PI)).mul(peak);
      hopFade = smoothstep(0, 0.12, phase).mul(smoothstep(0.82, 1, phase).oneMinus());
      // The streak follows the arc: up as it lifts, down as it lands.
      const climb = cos(phase.mul(Math.PI)).mul(peak).mul(Math.PI).div(hopLength.max(0.01));
      particleAxis = normalize(vec3(flat.x, climb, flat.z));
    }

    const heightRange = terrain.maxHeight - terrain.minHeight;
    const terrainUv = vec2(x, z).sub(vec2(terrain.boundsMin.x, terrain.boundsMin.z))
      .div(vec2(terrain.boundsSize.x, terrain.boundsSize.z)).clamp(0, 1);
    // Explicit level: implicit derivatives do not exist in the vertex stage.
    const ground = texture(terrain.texture, terrainUv).level(0).r.mul(heightRange).add(terrain.minHeight);
    let base;
    if (s.base === 'focus') base = this.center.y;
    else if (Number.isFinite(s.base)) base = float(s.base);
    else base = Number.isFinite(s.floor) ? max(ground, float(s.floor)) : ground;

    const range = Math.max(s.height[1] - s.height[0], 1e-3);
    const seedY = random('y', group);
    let height;
    let verticalFade = hopFade;
    if (hopArc) {
      height = hopArc;
    } else if (s.rise !== 0) {
      const speed = mix(float(0.6), float(1.4), seedSpeed).mul(s.rise / range);
      const t = fract(seedY.add(time.mul(speed)));
      height = t.mul(range);
      verticalFade = smoothstep(0, 0.1, t).mul(smoothstep(0.9, 1, t).oneMinus());
    } else {
      height = seedY.mul(range).add(sin(wanderRate.mul(0.6).add(seedPhase.mul(9))).mul(s.wander.radius * 0.4));
    }
    const y = base.add(s.height[0]).add(height).add(jitterY);
    const center = vec3(x, y, z);

    const mask = createRegionMaskNode(regions, s.regions, x, z, ground);
    let weight = mask.mul(edgeFade).mul(verticalFade).mul(this.intensity);
    if (s.gusts) {
      // Gust patches sweep downwind: the surface lifts in waves, not evenly.
      const drift = vec2(this.windAxis.x, this.windAxis.z).mul(time.mul(s.gusts.speed));
      const point = vec2(x, z).sub(drift).mul(s.gusts.scale);
      const gust = noise2(point).add(noise2(point.mul(2.3).add(vec2(5.1, -2.7))).mul(0.4));
      weight = weight.mul(smoothstep(s.gusts.threshold, s.gusts.threshold + 0.35, gust));
    }
    const size = mix(float(s.size[0]), float(s.size[1]), random('size'))
      .mul(weight.greaterThan(PARTICLE_CUTOFF).select(float(1), float(0)));

    const toParticle = center.sub(cameraPosition);
    const view = normalize(toParticle);
    let offset;
    if (s.shape === 'streak' || s.shape === 'shaft') {
      // Turned about its own axis to face the camera: along the wind for a
      // streak, along the sun's rays for a shaft.
      const axis = s.shape === 'shaft' ? sun : particleAxis;
      const side = normalize(cross(axis, view).add(cameraWorldMatrix.element(1).xyz.mul(1e-3)));
      if (s.shape === 'shaft') {
        offset = axis.mul(positionGeometry.y.add(0.5).mul(s.length)).add(side.mul(positionGeometry.x.mul(size)));
      } else {
        offset = axis.mul(positionGeometry.x.mul(size).mul(s.stretch)).add(side.mul(positionGeometry.y.mul(size)));
      }
    } else {
      const right = cameraWorldMatrix.element(0).xyz;
      const up = cameraWorldMatrix.element(1).xyz;
      offset = right.mul(positionGeometry.x.mul(size)).add(up.mul(positionGeometry.y.mul(size)));
    }

    const additive = s.blending === 'additive';
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    material.name = `Ambient ${this.name}`;
    // Scene fog would add its own colour to an additive particle; those fade
    // with distance on their own instead.
    material.fog = !additive;
    material.positionNode = center.add(offset);

    const local = uv().sub(0.5).mul(2);
    const variantSeed = random('variant');
    let alpha = shapeAlpha(s.shape, local, variantSeed, puffTexture);
    const distance = cameraPosition.distance(positionWorld);
    alpha = alpha.mul(smoothstep(s.nearFade, s.nearFade * 3, distance));
    if (additive) alpha = alpha.mul(smoothstep(s.area * 0.3, s.area * 0.5, distance).oneMinus());
    if (s.soft > 0 && s.base !== 'focus') {
      // Fade where the quad meets the ground (or the water it floats on), so
      // no billboard shows a straight cut line.
      alpha = alpha.mul(smoothstep(0, s.soft, positionWorld.y.sub(base)));
    }
    if (s.blink) {
      const pulse = sin(time.mul(s.blink.rate).mul(random('blink').mul(0.8).add(0.6)).add(seedPhase.mul(TWO_PI)))
        .mul(0.5).add(0.5);
      alpha = alpha.mul(pulse.pow(s.blink.sharpness));
    }
    if (s.twinkle > 0) {
      // Ice crystals flash as they turn.
      const flash = sin(time.mul(s.twinkle).mul(seedSpeed.add(0.5)).add(seedPhase.mul(TWO_PI))).mul(0.5).add(0.5);
      alpha = alpha.mul(flash.pow(6).mul(0.85).add(0.15));
    }

    const tone = mix(float(1 - s.toneVariation), float(1 + s.toneVariation), random('tone'));
    const albedo = color(s.color).mul(tone).mul(s.brightness);
    // mu is 1 looking straight into the sun.
    const mu = dot(normalize(positionWorld.sub(cameraPosition)), sun);
    const phase = cornetteShanks(mu);
    if (s.backlit < 1) alpha = alpha.mul(mix(float(s.backlit), float(1), phase.div(cornetteShanks(float(1))).clamp(0, 1)));

    if (s.lighting === 'emissive') {
      material.colorNode = albedo.mul(s.emissive);
    } else {
      material.colorNode = albedo.mul(light.sun.mul(phase.mul(s.scatter).add(SUN_BASE)).add(light.sky.mul(SKY_GAIN)));
    }
    material.opacityNode = alpha.mul(s.opacity).mul(weight);
    return material;
  }

  setCount(count) {
    this.mesh.count = Math.max(1, Math.min(this.settings.count, Math.round(count)));
  }

  setIntensity(value) {
    const next = THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
    this.current = next < FIELD_VISIBILITY_THRESHOLD ? 0 : next;
    this.intensity.value = this.current;
    this.mesh.visible = this.current > 0;
  }

  // `wind` is the field's drift velocity in m/s (x, z), `focus` the point the
  // field is centred on.
  update(delta, focus, wind) {
    const area = this.settings.area;
    this.drift.x = (this.drift.x + wind.x * delta) % area;
    this.drift.z = (this.drift.z + wind.z * delta) % area;
    this.center.value.set(focus.x, focus.y, focus.z);
    const wrapX = (this.drift.x - focus.x) / area + 0.5;
    const wrapZ = (this.drift.z - focus.z) / area + 0.5;
    this.wrap.value.set(wrapX - Math.floor(wrapX), wrapZ - Math.floor(wrapZ));
    const length = Math.hypot(wind.x, wind.z);
    if (length > 1e-4) this.windAxis.value.set(wind.x / length, 0, wind.z / length);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
