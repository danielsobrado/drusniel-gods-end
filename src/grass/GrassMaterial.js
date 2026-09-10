import {
  If,
  cos,
  float,
  mix,
  modelWorldMatrix,
  pow,
  sin,
  smoothstep,
  uniform,
  uniformArray,
  uv,
  vec2,
  vec4,
} from 'three/tsl';
import { Vector4 } from 'three';
import { LOD_ORDER } from './GrassFieldLayout.js';
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
    const cinematicWind = this.windConfig.model === CINEMATIC_MODEL;
    const cinematic = Boolean(config.cinematic?.enabled);
    const grass = config.grass[type];

    if (cinematicWind) {
      this.cinematic = {
        intensity: uniform(grass.windIntensity),
        directionDegrees: uniform(grass.windDirection),
        simulationSpeed: uniform(grass.simulationSpeed),
      };
      this.#publishSharedState(grass);
    } else this.cinematic = null;

    if (cinematic) {
      this.lodBands = uniformArray(Array.from({ length: 4 }, () => new Vector4(1, 1, 0, 1)));
    }

    this.recovered = new RecoveredGrassMaterial(
      config,
      terrainSampler,
      grassMask,
      interactionMap,
      type,
      atlasTexture,
      {
        includeRecoveredWind: !cinematicWind,
        includeRecoveredHeightVariation: !cinematic,
        includeCinematicHeight: cinematic,
        useCachedTerrainNormals: cinematic && config.cinematic?.style?.enabled,
        lodCoverage: cinematic ? (ctx) => this.#lodCoverage(ctx) : null,
        deformVisible: cinematicWind ? (ctx) => this.#applyCinematicWind(ctx) : null,
      },
    );
    this.material = this.recovered.material;
    this.uniforms = this.recovered.uniforms;
    this.shaderFeatures = this.recovered.shaderFeatures;
    if (this.cinematic) this.uniforms.windIntensity.value = 0;
  }

  #lodCoverage({ visibility, instanceData }) {
    const rank = instanceData.y;
    const distance = visibility.distance;
    const coverage = float(1).toVar();
    for (let i = 0; i < 4; i++) {
      const band = this.lodBands.element(i);
      If(rank.greaterThanEqual(band.z).and(rank.lessThan(band.y)), () => {
        const order = band.y.sub(rank).div(band.y.sub(band.z).max(1));
        const phase = smoothstep(band.x.sub(band.w), band.x, distance).mul(1.2);
        coverage.assign(float(1).sub(smoothstep(order, order.add(0.2), phase)));
      });
    }
    return coverage;
  }

  setLod(quality) {
    if (!this.lodBands) return;
    const counts = LOD_ORDER.map((name) => Math.floor(this.config.grass.tileSize * quality.lod[name].density) ** 2);
    LOD_ORDER.forEach((name, index) => {
      const end = quality.lod[name].distance * quality.maxDistance;
      const previous = index === 0 ? 0 : quality.lod[LOD_ORDER[index - 1]].distance * quality.maxDistance;
      this.lodBands.array[index].set(end, counts[index], counts[index + 1] ?? 0, Math.min(12, (end - previous) * 0.45));
    });
  }

  #applyCinematicWind({ local, instanceData }) {
    const response = this.windConfig.response[this.type];
    const sharedWind = getSharedWindUniforms();
    const bladeUv = uv();
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
