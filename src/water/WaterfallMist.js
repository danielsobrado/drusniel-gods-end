import * as THREE from 'three/webgpu';
import {
  attribute, cameraPosition, cameraViewMatrix, cameraWorldMatrix, color, cos, dot, fract, max, mix, normalize,
  positionGeometry, positionWorld, sin, smoothstep, texture, time, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { createSeededRandom } from '../core/math.js';
import { foliageLight } from '../rendering/CinematicLighting.js';
import { findRiverFalls } from './RiverCourse.js';
import { createSprayPuffTexture } from './waterfallTexture.js';

const MIST_SEED = 6089;
const QUALITY_SHARE = Object.freeze({ performance: 0.35, balanced: 0.6, high: 0.85, ultra: 1 });
// Mist beyond this is lost in the haze, so its draw is skipped.
const DRAW_DISTANCE = 650;
// Puffs this close to the camera collapse; they fade out over the next few metres.
const NEAR_COLLAPSE = 1.5;
const NEAR_FADE = 7;
// Height over the terrain or water across which a puff fades in, so it never
// shows the straight line where a billboard cuts into the ground.
const SOFT_HEIGHT = 0.8;
const MIE_G = 0.6;
// Brightest foliageLight.strength; sunlight is expressed relative to it.
const FULL_SUN_STRENGTH = 0.8;
const TWO_PI = Math.PI * 2;

/**
 * Spray puffs for each fall. Per particle: spawn (xyz, and the water level
 * there), motion (x and z drift in m/s, rise in m/s, phase) and shape (start
 * and end size in metres, lifetime in seconds, peak opacity). Most rise from
 * the plunge and drift downstream; some lift off the lower face of the fall.
 * Particles are ordered so any leading share is an even sample of every fall.
 */
export function createMistParticles(samples, falls, random = createSeededRandom(MIST_SEED)) {
  const particles = [];
  const sites = [];
  for (const fall of falls) {
    const foot = samples[fall.foot];
    const strength = THREE.MathUtils.clamp(fall.drop / 25, 0.35, 1.5);
    const count = Math.round(THREE.MathUtils.clamp(12 + fall.drop * 0.9, 12, 64));
    const faceStart = Math.round(fall.lip + (fall.foot - fall.lip) * 0.35);
    for (let k = 0; k < count; k += 1) {
      const face = random() < 0.25;
      const p = face ? samples[Math.round(THREE.MathUtils.lerp(faceStart, fall.foot, random()))] : foot;
      const across = (random() - 0.5) * (face ? 0.8 : 0.9) * p.width;
      const along = face ? 0 : -0.5 + random() * 3.5;
      const start = (1.6 + random() * 1.4) * (0.7 + 0.3 * strength) * (face ? 0.7 : 1);
      // Centred at least half a puff above the water, so it is not born faded.
      const lift = start * 0.5 + (face ? 0.3 + random() * 0.8 : random() * 0.8);
      const drift = 0.25 + random() * 0.65;
      const lateral = (random() - 0.5) * 0.8;
      const rise = (0.45 + random() * 0.9) * (0.6 + 0.4 * strength) * (face ? 0.6 : 1);
      const lifetime = face ? 2.5 + random() * 2 : 3.5 + random() * 3;
      const grow = 2.2 + random() * 1.4;
      const opacity = (0.26 + random() * 0.2) * (0.75 + 0.25 * strength) * (face ? 0.6 : 1);
      particles.push({
        priority: random(),
        spawn: [p.x - p.dz * across + p.dx * along, p.y + lift, p.z + p.dx * across + p.dz * along, p.y],
        motion: [p.dx * drift - p.dz * lateral, rise, p.dz * drift + p.dx * lateral, random()],
        shape: [start, start * grow, lifetime, opacity],
      });
    }
    const top = samples[faceStart];
    const center = new THREE.Vector3((top.x + foot.x) / 2, (top.y + foot.y) / 2 + 3, (top.z + foot.z) / 2);
    sites.push(new THREE.Sphere(center, center.distanceTo(new THREE.Vector3(foot.x, foot.y, foot.z)) + 18));
  }
  particles.sort((a, b) => a.priority - b.priority);
  const pack = key => Float32Array.from(particles.flatMap(particle => particle[key]));
  return { count: particles.length, spawn: pack('spawn'), motion: pack('motion'), shape: pack('shape'), sites };
}

// Camera-facing puffs animated on the GPU from each particle's constants: a
// puff rises and slows as it spreads, drifts downstream, turns slowly and fades
// in and out over its life. Lit like the snow powder spray (after Snowflow's
// spray shading, MIT): as a sphere with a lit and a shaded side, plus a strong
// forward-scattering lobe, so spray glows when seen against the sun.
function createMistMaterial(puffs, terrain, intensity) {
  const spawn = attribute('mistSpawn', 'vec4');
  const motion = attribute('mistMotion', 'vec4');
  const shape = attribute('mistShape', 'vec4');
  const age = fract(time.div(shape.z).add(motion.w));
  const seconds = age.mul(shape.z);
  // Height follows the integral of a rise speed that falls to zero at the end of life.
  const rise = motion.y.mul(seconds).mul(age.mul(-0.5).add(1));
  const center = vec3(spawn.x.add(motion.x.mul(seconds)), spawn.y.add(rise), spawn.z.add(motion.z.mul(seconds)));
  const turn = motion.w.mul(TWO_PI).add(age.mul(motion.w.sub(0.5)).mul(1.2));
  const spin = vec2(cos(turn), sin(turn));
  const size = mix(shape.x, shape.y, age.sqrt())
    .mul(smoothstep(NEAR_COLLAPSE, NEAR_COLLAPSE * 1.6, cameraPosition.distance(center)));
  const corner = positionGeometry.xy;
  const screen = vec2(corner.x.mul(spin.x).sub(corner.y.mul(spin.y)), corner.x.mul(spin.y).add(corner.y.mul(spin.x)));
  const right = cameraWorldMatrix.element(0).xyz;
  const up = cameraWorldMatrix.element(1).xyz;

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  material.name = 'Waterfall mist';
  material.fog = true;
  material.positionNode = center.add(right.mul(screen.x.mul(size))).add(up.mul(screen.y.mul(size)));

  const puff = texture(puffs, uv());
  const variant = fract(motion.w.mul(7.31)).mul(4).floor();
  const density = variant.lessThan(1).select(puff.r, variant.lessThan(2).select(puff.g,
    variant.lessThan(3).select(puff.b, puff.a)));
  const life = smoothstep(0, 0.1, age).mul(smoothstep(0.5, 1, age).oneMinus());
  const terrainUv = positionWorld.xz.sub(vec2(terrain.boundsMin.x, terrain.boundsMin.z))
    .div(vec2(terrain.boundsSize.x, terrain.boundsSize.z)).clamp(0, 1);
  const ground = texture(terrain.texture, terrainUv).r
    .mul(terrain.maxHeight - terrain.minHeight).add(terrain.minHeight);
  // Over the channel the ground is the carved bed, so the water level where
  // the puff rose is the surface there. (The river field texture is too coarse:
  // at a plunge it blends in the fall above and buries the lowest spray.)
  const soft = smoothstep(0, SOFT_HEIGHT, positionWorld.y.sub(max(ground, spawn.w)));
  const near = smoothstep(NEAR_COLLAPSE * 1.6, NEAR_FADE, cameraPosition.distance(positionWorld));
  material.opacityNode = density.mul(shape.w).mul(life).mul(soft).mul(near).mul(intensity);

  // The quad turns on screen, so its corner turns with it to give the sphere
  // normal in view space.
  const local = uv().sub(0.5).mul(2);
  const facing = vec2(local.x.mul(spin.x).sub(local.y.mul(spin.y)), local.x.mul(spin.y).add(local.y.mul(spin.x)));
  const radius2 = dot(facing, facing);
  const normalView = normalize(vec3(facing.x, facing.y, radius2.oneMinus().max(0).sqrt()));
  const lightView = normalize(cameraViewMatrix.mul(vec4(foliageLight.direction, 0)).xyz);
  const sun = foliageLight.color.mul(foliageLight.strength.div(FULL_SUN_STRENGTH));
  const diffuse = dot(normalView, lightView).mul(0.5).add(0.5);
  // Cornette-Shanks phase; mu is 1 looking straight into the sun.
  const mu = lightView.z.negate();
  const g2 = MIE_G * MIE_G;
  const phase = mu.mul(mu).add(1).mul((3 / (8 * Math.PI)) * (1 - g2) / (2 + g2))
    .div(mu.mul(-2 * MIE_G).add(1 + g2).pow(1.5));
  material.colorNode = color('#dcebf2')
    .mul(sun.mul(diffuse.mul(0.6).add(phase.mul(1.2))).add(foliageLight.fill.mul(1.2)));
  return material;
}

/** Spray mist rising from the plunge of every waterfall on the river. */
export class WaterfallMist {
  constructor(scene, river, terrain, { quality = 'high' } = {}) {
    const falls = river.falls ?? findRiverFalls(river.samples);
    const particles = createMistParticles(river.samples, falls);
    this.sites = particles.sites;
    this.total = particles.count;
    this.intensity = uniform(1);
    this.frustum = new THREE.Frustum();
    this.viewProjection = new THREE.Matrix4();
    this.cameraPosition = new THREE.Vector3();
    if (!this.total) return;

    this.puffs = createSprayPuffTexture();
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.geometry.setAttribute('mistSpawn', new THREE.InstancedBufferAttribute(particles.spawn, 4));
    this.geometry.setAttribute('mistMotion', new THREE.InstancedBufferAttribute(particles.motion, 4));
    this.geometry.setAttribute('mistShape', new THREE.InstancedBufferAttribute(particles.shape, 4));
    this.material = createMistMaterial(this.puffs, terrain, this.intensity);
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, this.total);
    this.mesh.name = 'Waterfall mist';
    // Every puff is placed by positionNode, so the instance transforms stay
    // identity and neither frustum nor occlusion bounds describe the mist.
    const identity = new THREE.Matrix4();
    for (let index = 0; index < this.total; index += 1) this.mesh.setMatrixAt(index, identity);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.frustumCulled = false;
    this.mesh.userData.occlusionCull = false;
    this.mesh.userData.excludeFromReflection = true;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Transparent draws sort by their group's renderOrder first. The water
    // tiles inherit 1 from their group and write no depth, so the mist needs a
    // later group of its own to be drawn over them.
    this.root = new THREE.Group();
    this.root.name = 'Waterfall mist';
    this.root.renderOrder = 2;
    this.root.add(this.mesh);
    this.setQuality(quality);
    scene.add(this.root);
  }

  setQuality(name) {
    if (!this.mesh) return;
    this.mesh.count = Math.max(1, Math.round(this.total * (QUALITY_SHARE[name] ?? QUALITY_SHARE.high)));
  }

  // Draws only while some fall's mist is near enough and inside the view.
  update(camera) {
    if (!this.mesh || !camera) return;
    camera.updateMatrixWorld();
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection, camera.coordinateSystem);
    camera.getWorldPosition(this.cameraPosition);
    this.mesh.visible = this.sites.some(site => site.distanceToPoint(this.cameraPosition) < DRAW_DISTANCE
      && this.frustum.intersectsSphere(site));
  }

  dispose() {
    this.root?.removeFromParent();
    this.geometry?.dispose();
    this.material?.dispose();
    this.puffs?.dispose();
  }
}
