import {
  Fn,
  attribute,
  cos,
  mix,
  modelWorldMatrix,
  pow,
  sin,
  uniform,
  uv,
  vec2,
  vec4,
} from 'three/tsl';
import {
  createCinematicWindFieldNode,
  getSharedWindUniforms,
  resolveWindConfig,
  setSharedWindState,
} from '../weather/WindField.js';
import { GrassMaterial as RecoveredGrassMaterial } from './RecoveredGrassMaterial.js';

const HALF_PI = Math.PI * 0.5;
const CINEMATIC_MODEL = 'cinematic';

export class GrassMaterial {
  constructor(
    config,
    terrainSampler,
    grassMask,
    interactionMap,
    type = config.grass.type,
    atlasTexture = null,
  ) {
    this.config = config;
    this.type = type;
    this.windConfig = resolveWindConfig(config);
    this.recovered = new RecoveredGrassMaterial(
      config,
      terrainSampler,
      grassMask,
      interactionMap,
      type,
      atlasTexture,
    );
    this.material = this.recovered.material;
    this.uniforms = this.recovered.uniforms;
    this.cinematic = null;

    if (this.windConfig.model === CINEMATIC_MODEL) this.#installCinematicWind(config.grass[type]);
  }

  #installCinematicWind(grass) {
    const response = this.windConfig.response[this.type];
    const sharedWind = getSharedWindUniforms();
    const basePositionNode = this.material.positionNode;
    const instanceData = attribute('instanceData', 'vec4');
    const bladeUv = uv();

    this.cinematic = {
      intensity: uniform(grass.windIntensity),
      directionDegrees: uniform(grass.windDirection),
      simulationSpeed: uniform(grass.simulationSpeed),
    };

    this.#publishSharedState(grass);
    this.uniforms.windIntensity.value = 0;

    this.material.positionNode = Fn(() => {
      const local = basePositionNode.toVar();
      const world = modelWorldMatrix.mul(vec4(local, 1)).xyz;
      const field = createCinematicWindFieldNode({
        positionXZ: world.xz,
        timeNode: this.uniforms.time,
        directionDegrees: this.cinematic.directionDegrees,
        intensity: this.cinematic.intensity,
        simulationSpeed: this.cinematic.simulationSpeed,
        noiseScale: sharedWind.noiseScale,
        config: this.config,
      });

      const heightRatio = bladeUv.y.clamp(0, 1);
      const instanceVariation = mix(
        response.variationMin,
        response.variationMax,
        instanceData.w,
      );
      const stemExponent = this.type === 'billboard'
        ? this.uniforms.bladeStiffness.max(2.5)
        : this.uniforms.bladeStiffness;
      const stemWeight = pow(heightRatio, stemExponent);
      const bendAngle = field.strength
        .mul(response.bendScale)
        .mul(HALF_PI)
        .mul(stemWeight)
        .mul(instanceVariation);
      const horizontal = this.uniforms.bladeHeight
        .mul(sin(bendAngle))
        .mul(heightRatio);

      local.x.addAssign(field.direction.x.mul(horizontal));
      local.z.addAssign(field.direction.y.mul(horizontal));
      local.y.subAssign(
        this.uniforms.bladeHeight
          .mul(cos(bendAngle).sub(1).abs())
          .mul(heightRatio),
      );

      const tipWeight = pow(heightRatio, response.tipExponent);
      const flutterVariation = mix(0.6, 1.4, instanceData.w);
      const flutterDistance = field.flutter
        .mul(this.cinematic.intensity)
        .mul(response.tipFlutter)
        .mul(this.uniforms.bladeHeight)
        .mul(tipWeight)
        .mul(flutterVariation);
      const perpendicular = vec2(field.direction.y.negate(), field.direction.x);
      local.x.addAssign(perpendicular.x.mul(flutterDistance));
      local.z.addAssign(perpendicular.y.mul(flutterDistance));
      return local;
    })();

    this.material.receivedShadowPositionNode = this.material.positionNode;
  }

  #publishSharedState(params) {
    if (this.type !== 'blade') return;
    const noiseReference = Math.max(this.windConfig.noiseScaleReference, 0.001);
    setSharedWindState({
      directionDegrees: params.windDirection,
      noiseScale: params.windNoiseScale / noiseReference,
      simulationSpeed: params.simulationSpeed,
    });
  }

  setPreset(params) {
    this.recovered.setPreset(params);
    if (!this.cinematic) return;

    this.cinematic.intensity.value = params.windIntensity;
    this.cinematic.directionDegrees.value = params.windDirection;
    this.cinematic.simulationSpeed.value = params.simulationSpeed;
    this.#publishSharedState(params);
    this.uniforms.windIntensity.value = 0;
  }

  setParameter(name, value) {
    this.recovered.setParameter(name, value);
    if (!this.cinematic) return;

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return;
    if (name === 'windIntensity') this.cinematic.intensity.value = numericValue;
    if (name === 'windDirection') this.cinematic.directionDegrees.value = numericValue;
    if (name === 'simulationSpeed') this.cinematic.simulationSpeed.value = numericValue;
    if (this.type === 'blade' && name === 'simulationSpeed') {
      setSharedWindState({ simulationSpeed: numericValue });
    }
    if (this.type === 'blade' && name === 'windNoiseScale') {
      const reference = Math.max(this.windConfig.noiseScaleReference, 0.001);
      setSharedWindState({ noiseScale: numericValue / reference });
    }
    if (this.type === 'blade' && name === 'windDirection') {
      setSharedWindState({ directionDegrees: numericValue });
    }
    this.uniforms.windIntensity.value = 0;
  }

  setFrame(elapsedSeconds, cameraPosition) {
    this.recovered.setFrame(elapsedSeconds, cameraPosition);
  }

  setViewProjection(matrix) {
    this.recovered.setViewProjection(matrix);
  }

  setMaxDistance(value) {
    this.recovered.setMaxDistance(value);
  }

  setInteractionCenter(center) {
    this.recovered.setInteractionCenter(center);
  }

  setBladeHeight(value) {
    this.recovered.setBladeHeight(value);
  }

  dispose() {
    this.recovered.dispose();
  }
}
