import { getPresetAppearance } from '../rendering/PresetAppearance.js';
import * as THREE from 'three/webgpu';
import { foliageBacklight, foliageLight } from '../rendering/CinematicLighting.js';
import { adventureCanopyColor } from '../rendering/AdventurePalette.js';
import {
  Fn,
  cos,
  materialColor,
  modelWorldMatrix,
  positionLocal,
  reference,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vertexColor,
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
    this.sharedMaterials = new Map();
    this.windConfig = resolveWindConfig(config);
    this.windSpeed = uniform(config.trees.windSpeed);
    this.windStrength = uniform(config.trees.windStrength);
    this.windFrequency = uniform(config.trees.windFrequency);
    this.simulationSpeed = uniform(config.trees.simulationSpeed);
    this.positionNode = this.windConfig.model === CINEMATIC_MODEL
      ? this.#createCinematicWindNode()
      : this.#createClassicWindNode();
  }

  #createClassicWindNode() {
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

  create(sourceMaterial, tint = null) {
    const source = Array.isArray(sourceMaterial) ? sourceMaterial[0] : sourceMaterial;
    const material = new THREE.MeshStandardNodeMaterial();
    material.map = source?.map ?? null;
    if (source?.color) material.color.copy(source.color);
    material.roughness = Number.isFinite(source?.roughness) ? source.roughness : 1;
    material.metalness = Number.isFinite(source?.metalness) ? source.metalness : 0;
    material.vertexColors = Boolean(source?.vertexColors);
    material.side = THREE.DoubleSide;
    material.transparent = false;
    material.depthWrite = true;
    material.alphaTestNode = LEAF_ALPHA_TEST;
    material.positionNode = this.positionNode;
    const tintNode = tint
      ? (tint.isNode ? tint : vec3(tint.r, tint.g, tint.b))
      : null;
    // vertexColor() is a vec4. Only its colour belongs in the tint: the alpha
    // beside it comes from the leaf texture, and multiplying a vec3 by the vec4
    // made the surrounding vec4(colour, alpha) a five-component join.
    const vertexTint = source?.vertexColors ? vertexColor().rgb : vec3(1, 1, 1);
    // materialColor folds the material's own map into the colour when one is
    // assigned, so using it beside an explicit leaf sample applies the texture
    // twice and yields a vec4. These branches sample the map themselves, so
    // they need the plain colour factor.
    const baseTint = uniform(material.color);
    if (material.map) {
      const leafSample = texture(material.map, uv());
      const sourceColor = leafSample.rgb.mul(baseTint).mul(vertexTint);
      const baseColor = tintNode ? sourceColor.mul(tintNode) : sourceColor;
      material.colorNode = vec4(baseColor, leafSample.a);
    } else if (tintNode || source?.vertexColors) {
      const sourceColor = materialColor.mul(vertexTint);
      material.colorNode = tintNode ? sourceColor.mul(tintNode) : sourceColor;
    }
    if (this.config.cinematic?.enabled && material.map) {
      const leafSample = texture(material.map, uv());
      const sourceColor = leafSample.rgb.mul(baseTint).mul(vertexTint);
      const canopy = adventureCanopyColor(sourceColor, this.config);
      const leafColor = tintNode ? canopy.mul(tintNode) : canopy;
      material.colorNode = vec4(leafColor, leafSample.a);
      material.emissiveNode = foliageBacklight(leafColor, 0.8);
      if (this.config.cinematic.style?.enabled) {
        material.emissiveNode = material.emissiveNode.add(
          leafColor.mul(foliageLight.fill).mul(getPresetAppearance(this.config).foliageFill),
        );
      }
      material.roughness = 0.82;
      material.alphaToCoverage = true;
    }
    if (material.map) {
      material.maskShadowNode = Fn(() => texture(material.map, uv()).a.greaterThan(SHADOW_ALPHA_TEST))();
    }
    return material;
  }

  createShared(sourceMaterial) {
    const source = Array.isArray(sourceMaterial) ? sourceMaterial[0] : sourceMaterial;
    if (!this.sharedMaterials.has(source)) {
      const material = this.create(source, reference('userData.treeAppearance.tint', 'color'));
      material.name = `TreeLeaves:${source?.name || 'foliage'}`;
      material.opacityNode = reference('userData.treeAppearance.opacity', 'float');
      this.sharedMaterials.set(source, material);
    }
    return this.sharedMaterials.get(source);
  }

  dispose() {
    for (const material of this.sharedMaterials.values()) material.dispose();
    this.sharedMaterials.clear();
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
