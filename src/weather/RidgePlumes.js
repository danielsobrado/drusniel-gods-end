import * as THREE from 'three/webgpu';
import {
  attribute, cameraPosition, cameraWorldMatrix, color, cos, dot, float, fract, mix, normalize, positionGeometry,
  positionWorld, sin, smoothstep, texture, time, uniform, uv, vec3,
} from 'three/tsl';
import { adoptInstanceMatrices } from '../rendering/instanceMatrices.js';
import { SKY_GAIN } from '../water/sceneLight.js';

const TWO_PI = Math.PI * 2;
const MIE_G = 0.65;
// Plumes this close to the camera thin out, so standing on a summit does not
// put a wall of spindrift in front of the lens.
const NEAR_FADE = [8, 40];
const PROMINENCE_DIRECTIONS = 12;

/**
 * Summit and ridge points that stand clear of their surroundings, highest
 * first and at least `spacing` apart. `sampleHeight(x, z)` is the terrain
 * height; `bounds` is { minX, maxX, minZ, maxZ }. Pure, so it can be tested
 * without a renderer.
 */
export function findCrestAnchors(sampleHeight, bounds, {
  minHeight, step, prominenceRadius, minProminence, spacing, count,
}) {
  const candidates = [];
  for (let z = bounds.minZ + step; z < bounds.maxZ - step; z += step) {
    for (let x = bounds.minX + step; x < bounds.maxX - step; x += step) {
      const height = sampleHeight(x, z);
      if (!(height >= minHeight)) continue;
      // A local maximum over its eight neighbours.
      let peak = true;
      for (let dz = -1; dz <= 1 && peak; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if ((dx || dz) && sampleHeight(x + dx * step, z + dz * step) > height) { peak = false; break; }
        }
      }
      if (!peak) continue;
      let ring = 0;
      for (let index = 0; index < PROMINENCE_DIRECTIONS; index += 1) {
        const angle = index / PROMINENCE_DIRECTIONS * TWO_PI;
        ring += sampleHeight(x + Math.cos(angle) * prominenceRadius, z + Math.sin(angle) * prominenceRadius);
      }
      const prominence = height - ring / PROMINENCE_DIRECTIONS;
      if (prominence >= minProminence) candidates.push({ x, z, y: height, prominence });
    }
  }
  candidates.sort((a, b) => b.y + b.prominence - (a.y + a.prominence));
  const anchors = [];
  const spacingSquared = spacing * spacing;
  for (const candidate of candidates) {
    if (anchors.length >= count) break;
    if (anchors.some(({ x, z }) => (x - candidate.x) ** 2 + (z - candidate.z) ** 2 < spacingSquared)) continue;
    anchors.push(candidate);
  }
  return anchors;
}

/**
 * Spindrift banners streaming off the summits on the snow wind: a few large,
 * soft puffs per crest that are born at the crest, ride downwind, grow and
 * fade, each plume breathing with its own gust. One instanced draw.
 */
export class RidgePlumes {
  constructor({ settings, anchors, wind, light, puffTexture }) {
    this.settings = settings;
    this.intensity = uniform(0);
    this.current = 0;
    const total = anchors.length * settings.puffs;
    this.total = total;
    if (!total) return;
    const anchorData = new Float32Array(total * 4);
    anchors.forEach((anchor, plume) => {
      const seed = ((plume * 0.618034) % 1 + 1) % 1;
      for (let puff = 0; puff < settings.puffs; puff += 1) {
        anchorData.set([anchor.x, anchor.y, anchor.z, seed], (plume * settings.puffs + puff) * 4);
      }
    });
    const puffIndex = new Float32Array(total);
    for (let index = 0; index < total; index += 1) puffIndex[index] = (index % settings.puffs) / settings.puffs;
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.geometry.setAttribute('plumeAnchor', new THREE.InstancedBufferAttribute(anchorData, 4));
    this.geometry.setAttribute('plumePuff', new THREE.InstancedBufferAttribute(puffIndex, 1));
    this.material = this.#createMaterial(wind, light, puffTexture);
    this.mesh = adoptInstanceMatrices(new THREE.InstancedMesh(this.geometry, this.material, total));
    this.mesh.name = 'Ambient ridge plumes';
    const identity = new THREE.Matrix4();
    for (let index = 0; index < total; index += 1) this.mesh.setMatrixAt(index, identity);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.userData.excludeFromReflection = true;
    this.mesh.userData.occlusionCull = false;
  }

  #createMaterial(wind, light, puffTexture) {
    const s = this.settings;
    const anchor = attribute('plumeAnchor', 'vec4');
    const seed = anchor.w;
    const puff = attribute('plumePuff', 'float');
    const age = fract(time.div(s.lifetime).add(puff).add(seed.mul(7.13)));
    const windLength = Math.hypot(wind.x, wind.z) || 1;
    const along = vec3(wind.x / windLength, 0, wind.z / windLength);
    const across = vec3(-wind.z / windLength, 0, wind.x / windLength);
    // Each puff leaves on a slightly different heading, so a plume fans out.
    const spread = fract(puff.mul(3.7).add(seed.mul(11.3))).sub(0.5);
    const travel = age.mul(s.length);
    const center = anchor.xyz
      .add(along.mul(travel))
      .add(across.mul(spread.mul(travel).mul(0.35).add(sin(time.mul(0.4).add(seed.mul(TWO_PI))).mul(age).mul(4))))
      .add(vec3(0, age.mul(s.rise).add(age.mul(age).mul(-s.rise * 0.4)), 0));
    const size = mix(float(s.size[0]), float(s.size[1]), age.sqrt());
    const spin = seed.mul(TWO_PI).add(age.mul(spread).mul(1.6));
    const corner = positionGeometry.xy;
    const turnedX = corner.x.mul(cos(spin)).sub(corner.y.mul(sin(spin)));
    const turnedY = corner.x.mul(sin(spin)).add(corner.y.mul(cos(spin)));
    const right = cameraWorldMatrix.element(0).xyz;
    const up = cameraWorldMatrix.element(1).xyz;

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    material.name = 'Ambient ridge plumes';
    material.fog = true;
    material.positionNode = center.add(right.mul(turnedX.mul(size))).add(up.mul(turnedY.mul(size)));

    const sample = texture(puffTexture, uv());
    const variant = fract(seed.mul(5.1).add(puff.mul(2.3))).mul(4).floor();
    const density = variant.lessThan(1).select(sample.r, variant.lessThan(2).select(sample.g,
      variant.lessThan(3).select(sample.b, sample.a)));
    const life = smoothstep(0, 0.12, age).mul(smoothstep(0.45, 1, age).oneMinus());
    // Each crest gusts on its own clock.
    const gust = sin(time.mul(TWO_PI / 13).add(seed.mul(TWO_PI))).mul(0.5).add(0.5);
    const near = smoothstep(NEAR_FADE[0], NEAR_FADE[1], cameraPosition.distance(positionWorld));
    material.opacityNode = density.mul(life).mul(gust.mul(0.6).add(0.4)).mul(near).mul(s.opacity).mul(this.intensity);

    const mu = dot(normalize(positionWorld.sub(cameraPosition)), light.direction);
    const g2 = MIE_G * MIE_G;
    const phase = mu.mul(mu).add(1).mul((3 / (8 * Math.PI)) * (1 - g2) / (2 + g2))
      .div(mu.mul(-2 * MIE_G).add(1 + g2).pow(1.5));
    // Brighter than a diffuse facet: the plume stands against HDR snow and sky.
    material.colorNode = color('#eef4fb').mul(light.sun.mul(phase.mul(2.2).add(0.8)).add(light.sky.mul(SKY_GAIN)))
      .mul(s.brightness);
    return material;
  }

  setIntensity(value) {
    if (!this.mesh) return;
    const next = THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
    this.current = next < 0.004 ? 0 : next;
    this.intensity.value = this.current;
    this.mesh.visible = this.current > 0;
  }

  dispose() {
    this.mesh?.removeFromParent();
    this.geometry?.dispose();
    this.material?.dispose();
  }
}
