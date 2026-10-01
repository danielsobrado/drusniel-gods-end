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
  transformNormalToView,
  uv,
  vec2,
  vec3,
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
import { GrassBladeMaterial } from './GrassBladeMaterial.js';
import { getPresetAppearance } from '../rendering/PresetAppearance.js';
import { writeGrassGust } from '../weather/ambientUniforms.js';

const HALF_PI = Math.PI * 0.5;
const CINEMATIC_MODEL = 'cinematic';

export class GrassMaterial {
  constructor(
    config,
    terrainSampler,
    vegetationField,
    interactionMap,
    type = config.grass.type,
    atlasTexture = null,
    referenceBiome = false,
    options = {},
  ) {
    this.config = config;
    this.type = type;
    this.far = Boolean(options.far);
    this.farAvailable = true;
    this.handoff = uniform(1e9);
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

    if (cinematic && !this.far) {
      this.lodBands = uniformArray(Array.from({ length: 4 }, () => new Vector4(1, 1, 0, 1)));
    }

    this.blades = new GrassBladeMaterial(
      config,
      terrainSampler,
      vegetationField,
      interactionMap,
      type,
      atlasTexture,
      {
        referenceBiome,
        batched: Boolean(options.batched),
        farBillboard: this.far,
        distanceCoverage: this.far ? (distance, uniforms) => smoothstep(this.handoff.mul(config.grass.far.transitionStart), this.handoff, distance)
          .mul(smoothstep(uniforms.maxDistance.mul(config.grass.far.fadeStart), uniforms.maxDistance, distance).oneMinus())
          : config.grass.far?.enabled ? (distance) => smoothstep(this.handoff.mul(config.grass.far.transitionStart), this.handoff, distance).oneMinus() : null,
        includeClassicWind: !cinematicWind,
        includeHeightHash: !cinematic,
        includeCinematicHeight: cinematic,
        useCachedTerrainNormals: cinematic && config.cinematic?.style?.enabled,
        lodCoverage: cinematic && !this.far ? (ctx) => this.#lodCoverage(ctx) : null,
        deformVisible: cinematicWind ? (ctx) => this.#applyCinematicWind(ctx) : null,
        // The world's terrain sampler, for its path field: `terrainSampler`
        // here is usually the grass's own baked height data, which has none.
        pathSampler: options.pathSampler ?? null,
      },
    );
    this.material = this.blades.material;
    if (this.far) this.material.normalNode = transformNormalToView(vec3(0, 1, 0));
    this.uniforms = this.blades.uniforms;
    this.shaderFeatures = this.blades.shaderFeatures;
    if (this.cinematic) this.uniforms.windIntensity.value = 0;
  }

  #lodCoverage({ visibility, instanceData }) {
    const appearance = getPresetAppearance(this.config);
    const rank = instanceData.y;
    const distance = visibility.distance;
    const coverage = float(1).toVar();
    const bands = this.config.grass.far?.enabled ? 3 : 4;
    // Stems per tile still standing here: those no band retires, plus each
    // band's retiring stems times the mean of their ramps below (1.1 - phase).
    const standing = this.lodBands.element(bands - 1).z.toVar();
    for (let i = 0; i < bands; i++) {
      const band = this.lodBands.element(i);
      const phase = smoothstep(band.x.sub(band.w), band.x, distance).mul(1.2).toVar();
      standing.addAssign(band.y.sub(band.z).mul(float(1.1).sub(phase).clamp(0, 1)));
      If(rank.greaterThanEqual(band.z).and(rank.lessThan(band.y)), () => {
        const order = band.y.sub(rank).div(band.y.sub(band.z).max(1));
        coverage.assign(float(1).sub(smoothstep(order, order.add(0.2), phase)));
      });
    }
    // A retiring stem shrank whole, so every band read as a strip of shorter,
    // sparser grass that moved with the camera. Thinning keeps the canopy
    // height, and widening the survivors by the share already retired keeps
    // its opacity: the count drops, the coverage does not.
    const thinning = appearance.grassLodThinning;
    const widen = mix(1, this.lodBands.element(0).y.div(standing.max(1)), appearance.grassLodCompensation)
      .min(appearance.grassLodWidenMax.max(1));
    return {
      coverage,
      width: mix(1, coverage, thinning).mul(widen).toVar(),
      shrink: mix(coverage, 1, thinning).toVar(),
    };
  }

  setLod(quality) {
    if (!this.lodBands) return;
    const counts = LOD_ORDER.map((name) => Math.floor(this.config.grass.tileSize * quality.lod[name].density) ** 2);
    LOD_ORDER.forEach((name, index) => {
      const end = quality.lod[name].distance * quality.maxDistance;
      const previous = index === 0 ? 0 : quality.lod[LOD_ORDER[index - 1]].distance * quality.maxDistance;
      // A wider window lets the extra stems of each band sink into the ground
      // over ~20 m instead of 12 m, so the density step reads as a gradient.
      this.lodBands.array[index].set(end, counts[index], counts[index + 1] ?? 0, Math.min(20, (end - previous) * 0.6));
    });
  }

  #applyCinematicWind({ local, instanceData, toWorld }) {
    const response = this.windConfig.response[this.type];
    const sharedWind = getSharedWindUniforms();
    const bladeUv = uv();
    const world = toWorld ? toWorld(local) : modelWorldMatrix.mul(vec4(local, 1)).xyz;
    const field = createCinematicWindFieldNode({
      positionXZ: world.xz,
      timeNode: this.uniforms.time,
      directionDegrees: this.cinematic.directionDegrees,
      intensity: this.cinematic.intensity,
      simulationSpeed: this.cinematic.simulationSpeed,
      noiseScale: sharedWind.noiseScale,
      config: this.config,
    });

    writeGrassGust(field.gust);
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
    this.blades.setPreset(params);
    if (!this.cinematic) return;

    this.cinematic.intensity.value = params.windIntensity;
    this.cinematic.directionDegrees.value = params.windDirection;
    this.cinematic.simulationSpeed.value = params.simulationSpeed;
    this.#publishSharedState(params);
    this.uniforms.windIntensity.value = 0;
  }

  setParameter(name, value) {
    this.blades.setParameter(name, value);
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
    this.blades.setFrame(elapsedSeconds, cameraPosition);
  }

  setViewProjection(matrix) {
    this.blades.setViewProjection(matrix);
  }

  setMaxDistance(value) {
    this.blades.setMaxDistance(value);
    if (!this.far) this.handoff.value = this.farAvailable ? value : 1e9;
  }

  setInteractionCenter(center) {
    this.blades.setInteractionCenter(center);
  }

  setBladeHeight(value) {
    this.blades.setBladeHeight(value);
  }

  dispose() {
    this.blades.dispose();
  }
}
