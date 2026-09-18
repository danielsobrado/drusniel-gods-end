import * as THREE from 'three/webgpu';
import {
  cameraPosition, cameraWorldMatrix, color, cos, float, fract, hash, instanceIndex, mix, positionGeometry,
  positionWorld, sin, smoothstep, time, uniform, vec3,
} from 'three/tsl';
import { resolveSnowfallConfig } from '../config/resolveSnowfallConfig.js';
import { foliageLight } from '../rendering/CinematicLighting.js';
import { sampleSurfaceCpu } from '../world/SnowDeformationField.js';
import { snowWindVector } from '../world/SnowPowderPhysics.js';

const VISIBILITY_THRESHOLD = 0.002;
const TWO_PI = Math.PI * 2;
const HASH_OFFSETS = Object.freeze({
  x: 13.17,
  z: 87.31,
  y: 43.79,
  speed: 67.13,
  size: 97.37,
  sway: 131.71,
  opacity: 179.23,
});

// Snowfall over snow-covered ground. One instanced, GPU-animated field that
// follows the view, the same shape as the rain system, but its intensity comes
// from the snow coverage under the focus point rather than from the weather
// preset: it snows on the alpine summit and nowhere else, and fades in as the
// player climbs into the snow line.
//
// The field holds several flake populations in contiguous instance ranges,
// typically fine snow spread wide, medium flakes around the player, and a few
// large out-of-focus flakes near the lens. All of them ride one gusting wind,
// each flake swirling across it on its own phase.
export class SnowfallSystem {
  constructor({ scene, terrainSampler, config }) {
    this.scene = scene;
    this.terrainSampler = terrainSampler;
    this.rootConfig = config;
    this.config = resolveSnowfallConfig(config.ground.snow.snowfall);
    this.intensity = uniform(0);
    this.center = uniform(new THREE.Vector3());
    this.current = 0;
    if (!this.config.enabled) return;

    const wind = snowWindVector(config.ground.snow.wind.angleDegrees, this.config.windSpeed);
    this.wind = wind;
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.material = this.#createMaterial();
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, this.config.count);
    this.mesh.name = 'Snowfall';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.userData.excludeFromReflection = true;
    // An InstancedMesh allocates its matrices zeroed, and a zero matrix collapses
    // every vertex onto the origin. Every flake is placed by positionNode, so the
    // instance transform only has to be identity.
    const identity = new THREE.Matrix4();
    for (let index = 0; index < this.config.count; index += 1) this.mesh.setMatrixAt(index, identity);
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  #createMaterial() {
    const settings = this.config;
    const index = instanceIndex.toFloat();
    const randomX = hash(index.add(float(HASH_OFFSETS.x)));
    const randomZ = hash(index.add(float(HASH_OFFSETS.z)));
    const randomY = hash(index.add(float(HASH_OFFSETS.y)));
    const randomSpeed = hash(index.add(float(HASH_OFFSETS.speed)));
    const randomSize = hash(index.add(float(HASH_OFFSETS.size)));
    const randomSway = hash(index.add(float(HASH_OFFSETS.sway)));
    const randomOpacity = hash(index.add(float(HASH_OFFSETS.opacity)));

    // Per-population values, chosen by the flake's instance range.
    const layers = settings.layers;
    const byLayer = (pick) => layers.slice(0, -1).reduceRight(
      (rest, layer) => index.lessThan(float(layer.end)).select(float(pick(layer)), rest),
      float(pick(layers.at(-1))),
    );
    const area = byLayer(layer => layer.area);
    const range = float(settings.top - settings.bottom);
    // Flakes fall slowly and wrap through the column, so the field never empties.
    const fallSpeed = mix(float(settings.speed * 0.6), float(settings.speed * 1.35), randomSpeed)
      .mul(byLayer(layer => layer.speedScale));
    const y = fract(randomY.sub(time.mul(fallSpeed).div(range))).mul(range).add(float(settings.bottom));

    // The prevailing snow wind drifts the whole column. Gusts vary its speed;
    // the drift follows the integral of that speed, so a gust never makes the
    // wrapped column jump.
    const gustRate = TWO_PI / settings.gust.period;
    const gustStrength = settings.gust.strength;
    const windTime = time
      .add(sin(time.mul(gustRate)).mul(gustStrength / gustRate))
      .add(sin(time.mul(gustRate * 2.7).add(1.3)).mul(gustStrength * 0.4 / (gustRate * 2.7)));
    const driftX = fract(randomX.add(windTime.mul(this.wind.x).div(area))).sub(0.5).mul(area);
    const driftZ = fract(randomZ.add(windTime.mul(this.wind.z).div(area))).sub(0.5).mul(area);
    // Each flake swings on its own phase so they do not fall as a rigid
    // lattice, and eddies swirl it across the wind, varying with height.
    const swayPhase = time.mul(settings.swayFrequency).add(randomSway.mul(TWO_PI));
    const windLength = Math.hypot(this.wind.x, this.wind.z) || 1;
    const acrossX = -this.wind.z / windLength;
    const acrossZ = this.wind.x / windLength;
    const eddy = sin(time.mul(0.9).add(y.mul(0.13)).add(randomSway.mul(TWO_PI * 3)))
      .mul(settings.turbulence);
    const flakeX = this.center.x.add(driftX).add(sin(swayPhase).mul(settings.swayRadius)).add(eddy.mul(acrossX));
    const flakeZ = this.center.z.add(driftZ).add(cos(swayPhase.mul(0.83)).mul(settings.swayRadius)).add(eddy.mul(acrossZ));
    const flakeY = this.center.y.add(y);

    // Fully camera-facing. A flake is round from every side; a rain-style
    // upright billboard turns edge-on seen from above and draws as a grid of
    // lines over the field.
    const right = cameraWorldMatrix.element(0).xyz;
    const up = cameraWorldMatrix.element(1).xyz;
    const size = mix(byLayer(layer => layer.sizeMin), byLayer(layer => layer.sizeMax), randomSize);
    const offset = right.mul(positionGeometry.x.mul(size)).add(up.mul(positionGeometry.y.mul(size)));

    const material = new THREE.MeshBasicNodeMaterial();
    material.name = 'Snowfall';
    material.transparent = true;
    material.side = THREE.DoubleSide;
    material.depthWrite = false;
    material.fog = true;
    material.positionNode = vec3(flakeX, flakeY, flakeZ).add(offset);

    // A round, soft flake, or an out-of-focus disc for the softest population,
    // faded out close to the camera so a flake crossing the lens does not
    // become a white slab.
    const edge = positionGeometry.xy.length().mul(2);
    const crisp = edge.oneMinus().clamp(0, 1).pow(1.4);
    const defocused = smoothstep(float(0), float(0.65), edge.oneMinus());
    const radial = mix(crisp, defocused, byLayer(layer => layer.softness));
    const fadeStart = byLayer(layer => Math.max(layer.nearFade, 0.001));
    const nearFade = smoothstep(fadeStart, fadeStart.mul(3), cameraPosition.distance(positionWorld));
    material.opacityNode = radial
      .mul(mix(float(0.55), float(1), randomOpacity))
      .mul(byLayer(layer => layer.opacity))
      .mul(nearFade)
      .mul(this.intensity);
    // Lit by the same cinematic sun uniforms as the rest of the snow, so flakes
    // go grey at dusk instead of glowing.
    material.colorNode = color(settings.color)
      .mul(foliageLight.color.mul(foliageLight.strength).add(foliageLight.fill).clamp(0, 1.4))
      .mul(byLayer(layer => layer.brightness));
    return material;
  }

  setIntensity(value) {
    const raw = THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
    const intensity = raw < VISIBILITY_THRESHOLD ? 0 : raw;
    this.current = intensity;
    this.intensity.value = intensity;
    if (this.mesh) this.mesh.visible = intensity > VISIBILITY_THRESHOLD;
  }

  // `focusPosition` is the player, or the camera while touring or free-flying.
  update(deltaSeconds, focusPosition) {
    if (!this.config.enabled || !focusPosition) return;
    const delta = Math.min(Math.max(Number(deltaSeconds) || 0, 0), 0.1);
    const surface = sampleSurfaceCpu(
      this.terrainSampler,
      focusPosition.x,
      focusPosition.z,
      this.config.sampleDistance,
      this.rootConfig,
    );
    const coverage = surface ? surface.snow : 0;
    const target = THREE.MathUtils.smoothstep(coverage, this.config.minCoverage, this.config.fullCoverage)
      * this.config.maxIntensity;
    // Eased, so walking over a bare ridge does not switch the weather. The ease
    // snaps once it is within a flake's worth of the target: an exponential
    // never reaches zero, and a field left at 0.01 is invisible but still drawn.
    const eased = target + (this.current - target) * Math.exp(-this.config.fadeRate * delta);
    this.setIntensity(Math.abs(eased - target) < VISIBILITY_THRESHOLD * 2 ? target : eased);
    this.center.value.set(focusPosition.x, focusPosition.y, focusPosition.z);
  }

  dispose() {
    this.mesh?.removeFromParent();
    this.geometry?.dispose();
    this.material?.dispose();
    this.scene = null;
  }
}
