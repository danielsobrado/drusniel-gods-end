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

    const area = float(settings.area);
    const range = float(settings.top - settings.bottom);
    // Flakes fall slowly and wrap through the column, so the field never empties.
    const fallSpeed = mix(float(settings.speed * 0.6), float(settings.speed * 1.35), randomSpeed);
    const y = fract(randomY.sub(time.mul(fallSpeed).div(range))).mul(range).add(float(settings.bottom));

    // The prevailing snow wind drifts the whole column, and each flake swings on
    // its own phase so they do not fall as a rigid lattice.
    const driftX = fract(randomX.add(time.mul(this.wind.x).div(area))).sub(0.5).mul(area);
    const driftZ = fract(randomZ.add(time.mul(this.wind.z).div(area))).sub(0.5).mul(area);
    const swayPhase = time.mul(settings.swayFrequency).add(randomSway.mul(TWO_PI));
    const flakeX = this.center.x.add(driftX).add(sin(swayPhase).mul(settings.swayRadius));
    const flakeZ = this.center.z.add(driftZ).add(cos(swayPhase.mul(0.83)).mul(settings.swayRadius));
    const flakeY = this.center.y.add(y);

    // Fully camera-facing. A flake is round from every side; a rain-style
    // upright billboard turns edge-on seen from above and draws as a grid of
    // lines over the field.
    const right = cameraWorldMatrix.element(0).xyz;
    const up = cameraWorldMatrix.element(1).xyz;
    const size = mix(float(settings.sizeMin), float(settings.sizeMax), randomSize);
    const offset = right.mul(positionGeometry.x.mul(size)).add(up.mul(positionGeometry.y.mul(size)));

    const material = new THREE.MeshBasicNodeMaterial();
    material.name = 'Snowfall';
    material.transparent = true;
    material.side = THREE.DoubleSide;
    material.depthWrite = false;
    material.fog = true;
    material.positionNode = vec3(flakeX, flakeY, flakeZ).add(offset);

    // A round, soft flake, faded out close to the camera so a flake crossing
    // the lens does not become a white slab.
    const radial = positionGeometry.xy.length().mul(2).oneMinus().clamp(0, 1).pow(1.4);
    const nearFade = settings.nearFade > 0
      ? smoothstep(float(settings.nearFade), float(settings.nearFade * 3), cameraPosition.distance(positionWorld))
      : float(1);
    material.opacityNode = radial
      .mul(mix(float(0.55), float(1), randomOpacity))
      .mul(settings.opacity)
      .mul(nearFade)
      .mul(this.intensity);
    // Lit by the same cinematic sun uniforms as the rest of the snow, so flakes
    // go grey at dusk instead of glowing.
    material.colorNode = color(settings.color)
      .mul(foliageLight.color.mul(foliageLight.strength).add(foliageLight.fill).clamp(0, 1.4));
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
