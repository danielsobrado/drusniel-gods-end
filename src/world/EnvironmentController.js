import * as THREE from 'three';

const TRANSITION_SECONDS = 5;
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

function cloneSnapshot(value) {
  return snapshot({
    grass: {
      blade: {
        ...value.grass.blade,
        baseColor: value.grass.blade.baseColor,
        tipColor: value.grass.blade.tipColor,
      },
      billboard: {
        ...value.grass.billboard,
        baseColor: value.grass.billboard.baseColor,
        tipColor: value.grass.billboard.tipColor,
      },
    },
    lighting: {
      ...value.lighting,
      color: value.lighting.color,
      position: value.lighting.position.toArray(),
      hemisphereSkyColor: value.lighting.hemisphereSkyColor,
      hemisphereGroundColor: value.lighting.hemisphereGroundColor,
      ambientColor: value.lighting.ambientColor,
    },
    sky: {
      ...value.sky,
      groundColor: value.sky.groundColor,
      horizonColor: value.sky.horizonColor,
      zenithColor: value.sky.zenithColor,
      sunHaloColor: value.sky.sunHaloColor,
      sunDiskColor: value.sky.sunDiskColor,
      sunPosition: value.sky.sunPosition.toArray(),
      fogColor: value.sky.fogColor,
    },
    cloudCoverage: value.cloudCoverage,
    rainIntensity: value.rainIntensity,
  });
}

function power2InOut(value) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t < 0.5
    ? 4 * t * t * t
    : 1 - ((-2 * t + 2) ** 3) / 2;
}

function blendGrass(current, start, target, t) {
  for (const key of GRASS_TYPES) {
    const currentGrass = current[key];
    const startGrass = start[key];
    const targetGrass = target[key];
    for (const field of [
      'bladeHeight',
      'bladeWidth',
      'bladeStiffness',
      'baseBend',
      'windIntensity',
      'windDirection',
      'windNoiseScale',
      'simulationSpeed',
      'sheen',
    ]) {
      currentGrass[field] = THREE.MathUtils.lerp(startGrass[field], targetGrass[field], t);
    }
    currentGrass.baseColor.copy(startGrass.baseColor).lerp(targetGrass.baseColor, t);
    currentGrass.tipColor.copy(startGrass.tipColor).lerp(targetGrass.tipColor, t);
  }
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
    const initial = snapshot(config.presets[config.ui.initialPreset]);
    this.current = cloneSnapshot(initial);
    this.start = cloneSnapshot(initial);
    this.target = cloneSnapshot(initial);
    this.elapsed = TRANSITION_SECONDS;
    this.settled = false;
    this.#apply();
  }

  setPreset(name) {
    const preset = this.config.presets[name];
    if (!preset) throw new Error(`Unknown environment preset: ${name}`);
    this.settled = false;
    this.start = cloneSnapshot(this.current);
    this.target = snapshot(preset);
    this.elapsed = 0;
    this.audio?.setPreset?.(name);
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
    setGrassSnapshotParameter(this.start, name, numericValue);
    setGrassSnapshotParameter(this.target, name, numericValue);
    this.#apply();
  }

  update(deltaSeconds) {
    if (this.settled) return;
    this.elapsed = Math.min(TRANSITION_SECONDS, this.elapsed + deltaSeconds);
    const t = power2InOut(this.elapsed / TRANSITION_SECONDS);
    blendGrass(this.current.grass, this.start.grass, this.target.grass, t);

    const lighting = this.current.lighting;
    lighting.color.copy(this.start.lighting.color).lerp(this.target.lighting.color, t);
    lighting.position.copy(this.start.lighting.position).lerp(this.target.lighting.position, t);
    lighting.hemisphereSkyColor.copy(this.start.lighting.hemisphereSkyColor)
      .lerp(this.target.lighting.hemisphereSkyColor, t);
    lighting.hemisphereGroundColor.copy(this.start.lighting.hemisphereGroundColor)
      .lerp(this.target.lighting.hemisphereGroundColor, t);
    lighting.ambientColor.copy(this.start.lighting.ambientColor)
      .lerp(this.target.lighting.ambientColor, t);
    for (const field of [
      'directionalIntensity',
      'hemisphereIntensity',
      'ambientIntensity',
      'environmentIntensity',
    ]) {
      lighting[field] = THREE.MathUtils.lerp(
        this.start.lighting[field],
        this.target.lighting[field],
        t,
      );
    }

    const sky = this.current.sky;
    for (const field of [
      'groundColor',
      'horizonColor',
      'zenithColor',
      'sunHaloColor',
      'sunDiskColor',
      'fogColor',
    ]) {
      sky[field].copy(this.start.sky[field]).lerp(this.target.sky[field], t);
    }
    sky.sunPosition.copy(this.start.sky.sunPosition).lerp(this.target.sky.sunPosition, t);
    sky.haloPower = THREE.MathUtils.lerp(this.start.sky.haloPower, this.target.sky.haloPower, t);
    sky.diskPower = THREE.MathUtils.lerp(this.start.sky.diskPower, this.target.sky.diskPower, t);
    sky.fogDensity = THREE.MathUtils.lerp(
      this.start.sky.fogDensity,
      this.target.sky.fogDensity,
      t,
    );
    this.current.cloudCoverage = THREE.MathUtils.lerp(
      this.start.cloudCoverage,
      this.target.cloudCoverage,
      t,
    );
    this.current.rainIntensity = THREE.MathUtils.lerp(
      this.start.rainIntensity,
      this.target.rainIntensity,
      t,
    );
    this.#apply();
    if (this.elapsed >= TRANSITION_SECONDS) this.settled = true;
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
