import * as THREE from 'three';

const GRASS_TYPES = ['blade', 'billboard'];
const RAIN_ACTIVE_THRESHOLD = 0.001;
const DEFAULT_TREE_WIND_SPEED_MULTIPLIER = 2;
const DEFAULT_LEAF_WIND_STRENGTH_MULTIPLIER = 1;

function color(value) {
  return new THREE.Color(value);
}

function grassSnapshot(value) {
  return {
    ...value,
    baseColor: color(value.baseColor),
    tipColor: color(value.tipColor),
  };
}

function snapshot(preset) {
  return {
    grass: {
      blade: grassSnapshot(preset.grass.blade),
      billboard: grassSnapshot(preset.grass.billboard),
    },
    lighting: {
      color: color(preset.lighting.color),
      directionalIntensity: preset.lighting.directionalIntensity,
      position: new THREE.Vector3().fromArray(preset.lighting.position),
      hemisphereSkyColor: color(preset.lighting.hemisphereSkyColor),
      hemisphereGroundColor: color(preset.lighting.hemisphereGroundColor),
      hemisphereIntensity: preset.lighting.hemisphereIntensity,
      ambientColor: color(preset.lighting.ambientColor),
      ambientIntensity: preset.lighting.ambientIntensity,
      environmentIntensity: preset.lighting.environmentIntensity,
    },
    sky: {
      groundColor: color(preset.sky.groundColor),
      horizonColor: color(preset.sky.horizonColor),
      zenithColor: color(preset.sky.zenithColor),
      sunHaloColor: color(preset.sky.sunHaloColor),
      sunDiskColor: color(preset.sky.sunDiskColor),
      haloPower: preset.sky.haloPower,
      diskPower: preset.sky.diskPower,
      sunPosition: new THREE.Vector3().fromArray(preset.sky.sunPosition),
      fogColor: color(preset.sky.fogColor),
      fogDensity: preset.sky.fogDensity,
    },
    cloudCoverage: preset.cloudCoverage,
    rainIntensity: preset.rainIntensity ?? (preset.rain ? 1 : 0),
  };
}

function setGrassSnapshotParameter(state, name, value) {
  for (const type of GRASS_TYPES) {
    if (typeof state.grass[type]?.[name] === 'number') state.grass[type][name] = value;
  }
}

export class EnvironmentController {
  constructor({
    scene,
    sun,
    hemisphere,
    ambient,
    sky,
    clouds,
    grass,
    rain,
    water,
    trees,
    leaves,
    audio,
    terrain,
    config,
  }) {
    this.scene = scene;
    this.sun = sun;
    this.hemisphere = hemisphere;
    this.ambient = ambient;
    this.sky = sky;
    this.clouds = clouds;
    this.grass = grass;
    this.rain = rain;
    this.water = water;
    this.trees = trees;
    this.leaves = leaves;
    this.audio = audio;
    this.terrain = terrain;
    this.config = config;
    this.quality = config.ui.initialQuality;
    this.currentPreset = config.ui.initialPreset;
    this.current = snapshot(config.presets[config.ui.initialPreset]);
    this.#apply();
  }

  // A hard cut, not a cross-fade: the caller plays this behind a closed iris,
  // so interpolating the sun across the sky would only read as a time-lapse.
  setPreset(name) {
    const preset = this.config.presets[name];
    if (!preset) throw new Error(`Unknown environment preset: ${name}`);
    this.currentPreset = name;
    this.current = snapshot(preset);
    this.audio?.setPreset?.(name);
    this.#apply();
  }

  setQuality(name) {
    if (!this.config.quality[name]) return;
    this.quality = name;
    this.#apply();
  }

  setGrassParameter(name, value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return;
    setGrassSnapshotParameter(this.current, name, numericValue);
    this.#apply();
  }

  updateSunTarget(playerPosition) {
    this.sun.position.copy(playerPosition).add(this.current.lighting.position);
    this.sun.target.position.copy(playerPosition);
    this.sun.target.updateMatrixWorld();
  }

  #apply() {
    const lighting = this.current.lighting;
    this.sun.color.copy(lighting.color);
    this.sun.intensity = lighting.directionalIntensity;
    this.hemisphere.color.copy(lighting.hemisphereSkyColor);
    this.hemisphere.groundColor.copy(lighting.hemisphereGroundColor);
    this.hemisphere.intensity = lighting.hemisphereIntensity;
    this.ambient.color.copy(lighting.ambientColor);
    this.ambient.intensity = lighting.ambientIntensity;
    this.scene.environmentIntensity = lighting.environmentIntensity;

    const fogMultiplier = this.config.quality[this.quality].fogMultiplier;
    this.scene.fog.color.copy(this.current.sky.fogColor);
    this.scene.fog.density = this.current.sky.fogDensity * fogMultiplier;
    this.grass.setPreset({ grass: this.current.grass });
    this.#applyVegetationSimulation();
    this.rain?.setWindStrength(
      this.current.grass.blade.windIntensity * (this.config.rain.windStrengthMultiplier ?? 10),
    );
    this.#applyRainIntensity(this.current.rainIntensity);
    this.#applyRainRoughness(this.current.rainIntensity);
    this.clouds?.setCoverage(this.current.cloudCoverage);
    this.sky?.setPreset({
      ...this.current.sky,
      sunPosition: this.current.sky.sunPosition.toArray(),
    });
  }

  #applyVegetationSimulation() {
    const grass = this.current.grass.blade;
    const treeWindMultiplier = this.config.trees.windSpeedMultiplier
      ?? DEFAULT_TREE_WIND_SPEED_MULTIPLIER;
    const leafWindMultiplier = this.config.leaves.windStrengthMultiplier
      ?? DEFAULT_LEAF_WIND_STRENGTH_MULTIPLIER;

    this.trees?.setWindSpeed(grass.windIntensity * treeWindMultiplier);
    this.trees?.setSimulationSpeed(grass.simulationSpeed);
    this.leaves?.setWindStrength(grass.windIntensity * leafWindMultiplier);
    this.leaves?.setSimulationSpeed(grass.simulationSpeed);
  }

  #applyRainIntensity(value) {
    const intensity = THREE.MathUtils.clamp(Number(value), 0, 1);
    this.rain?.setIntensity(intensity);

    const groundRain = this.terrain?.material?.userData;
    if (groundRain) {
      if (typeof groundRain.setRainIntensity === 'function') groundRain.setRainIntensity(intensity);
      else groundRain.setRain?.(intensity > RAIN_ACTIVE_THRESHOLD);
      if (groundRain.rippleAmount) {
        const maximum = this.config.ground.rainRipple?.amount ?? 0.7;
        groundRain.rippleAmount.value = THREE.MathUtils.lerp(0, maximum, intensity);
      }
    }

    this.water?.setRainIntensity(intensity);
  }

  #applyRainRoughness(value) {
    const intensity = THREE.MathUtils.clamp(Number(value), 0, 1);
    const defaultRainRoughness = this.config.rain.defaultRoughness ?? 0.2;
    this.scene.traverse((object) => {
      if (!object.isMesh || object.userData.grid || !object.material) return;
      const material = object.material;
      if (material.roughness === undefined) return;
      if (object.userData.originalRoughness === undefined) {
        object.userData.originalRoughness = material.roughness;
      }
      const target = object.userData.rainRoughness ?? defaultRainRoughness;
      material.roughness = THREE.MathUtils.lerp(
        object.userData.originalRoughness,
        target,
        intensity,
      );
    });
  }
}
