import * as THREE from 'three/webgpu';
import { foliageBacklight } from '../rendering/CinematicLighting.js';
import {
  Fn,
  cos,
  modelWorldMatrix,
  positionLocal,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  createCinematicWindFieldNode,
  getSharedWindUniforms,
  resolveWindConfig,
} from '../weather/WindField.js';

const LEAF_ALPHA_TEST = 0.5;
const SHADOW_ALPHA_TEST = 0.6;
const CINEMATIC_MODEL = 'cinematic';

export class TreeLeafMaterialFactory {
  constructor(config) {
    this.config = config;
    this.windConfig = resolveWindConfig(config);
    this.windSpeed = uniform(config.trees.windSpeed);
    this.windStrength = uniform(config.trees.windStrength);
    this.windFrequency = uniform(config.trees.windFrequency);
    this.simulationSpeed = uniform(config.trees.simulationSpeed);
    this.positionNode = this.windConfig.model === CINEMATIC_MODEL
      ? this.#createCinematicWindNode()
      : this.#createRecoveredWindNode();
  }

  #createRecoveredWindNode() {
    const windSpeed = this.windSpeed;
    const windStrength = this.windStrength;
    const windFrequency = this.windFrequency;
    const simulationSpeed = this.simulationSpeed;

    return Fn(() => {
      const position = positionLocal;
      const clock = time.mul(simulationSpeed).mul(windSpeed);
      const waveA = sin(
        position.x.mul(0.18).mul(windFrequency)
          .add(position.z.mul(0.14).mul(windFrequency))
          .add(clock),
      );
      const waveB = cos(
        position.z.mul(0.22).mul(windFrequency)
          .add(position.x.mul(0.08).mul(windFrequency))
          .add(clock.mul(0.72)),
      );
      const waveC = sin(
        position.x.mul(0.55).mul(windFrequency)
          .add(position.z.mul(0.42).mul(windFrequency))
          .add(clock.mul(1.35)),
      );
      const detail = sin(
        position.x.mul(2.5).mul(windFrequency)
          .add(position.z.mul(2).mul(windFrequency))
          .add(clock.mul(3.5)),
      );
      const x = waveA.mul(0.32)
        .add(waveB.mul(0.16))
        .add(waveC.mul(0.1))
        .add(detail.mul(0.025));
      const z = waveB.mul(0.28)
        .add(waveA.mul(0.12))
        .add(waveC.mul(0.08))
        .add(detail.mul(0.025));
      return position.add(vec3(x, 0, z).mul(windStrength));
    })();
  }

  #createCinematicWindNode() {
    const sharedWind = getSharedWindUniforms();
    const response = this.windConfig.response.trees;

    return Fn(() => {
      const position = positionLocal;
      const world = modelWorldMatrix.mul(vec4(position, 1)).xyz;
      const field = createCinematicWindFieldNode({
        positionXZ: world.xz,
        timeNode: time,
        directionDegrees: sharedWind.directionDegrees,
        intensity: this.windSpeed,
        simulationSpeed: this.simulationSpeed,
        noiseScale: sharedWind.noiseScale.mul(this.windFrequency),
        config: this.config,
      });

      const heightWeight = smoothstep(0, response.heightMeters, position.y.max(0));
      const outerWeight = smoothstep(0, response.outerRadius, position.xz.length());
      const canopyWeight = heightWeight.mul(0.7).add(outerWeight.mul(0.3)).clamp(0, 1);
      const bendDistance = field.strength
        .mul(response.bendScale)
        .mul(this.windStrength)
        .mul(canopyWeight);
      const perpendicular = vec2(field.direction.y.negate(), field.direction.x);
      const flutterDistance = field.flutter
        .mul(this.windSpeed)
        .mul(response.flutterScale)
        .mul(outerWeight);

      return position.add(vec3(
        field.direction.x.mul(bendDistance).add(perpendicular.x.mul(flutterDistance)),
        0,
        field.direction.y.mul(bendDistance).add(perpendicular.y.mul(flutterDistance)),
      ));
    })();
  }

  create(sourceMaterial) {
    const source = Array.isArray(sourceMaterial) ? sourceMaterial[0] : sourceMaterial;
    const material = new THREE.MeshStandardNodeMaterial();
    material.map = source?.map ?? null;
    material.side = THREE.DoubleSide;
    material.transparent = false;
    material.depthWrite = true;
    material.alphaTestNode = LEAF_ALPHA_TEST;
    material.positionNode = this.positionNode;
    if (this.config.cinematic?.enabled && material.map) {
      const leafColor = texture(material.map, uv()).rgb;
      material.emissiveNode = foliageBacklight(leafColor, 0.5);
      material.roughness = 0.82;
      material.alphaToCoverage = true;
    }
    if (material.map) {
      material.maskShadowNode = Fn(() => texture(material.map, uv()).a.greaterThan(SHADOW_ALPHA_TEST))();
    }
    return material;
  }

  setWindSpeed(value) {
    this.windSpeed.value = Number(value);
  }

  setWindStrength(value) {
    this.windStrength.value = Number(value);
  }

  setSimulationSpeed(value) {
    this.simulationSpeed.value = Number(value);
  }
}
