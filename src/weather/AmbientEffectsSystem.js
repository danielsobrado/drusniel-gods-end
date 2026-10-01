import * as THREE from 'three/webgpu';
import { presetWeight, resolveAmbientEffectsConfig, windFactor } from '../config/resolveAmbientEffectsConfig.js';
import { createSceneLight } from '../water/sceneLight.js';
import { createSprayPuffTexture } from '../water/waterfallTexture.js';
import { snowWindVector } from '../world/SnowPowderPhysics.js';
import { AmbientParticleField, FIELD_VISIBILITY_THRESHOLD } from './AmbientParticleField.js';
import { ambientUniforms } from './ambientUniforms.js';
import { regionWeight, resolveAmbientRegions, sampleAmbientRegions } from './ambientRegions.js';
import { BreathPuffs } from './BreathPuffs.js';
import { findCrestAnchors, RidgePlumes } from './RidgePlumes.js';

const TWO_PI = Math.PI * 2;
const MAX_STEP_SECONDS = 0.1;
// The blown-streak travel wraps here so its float32 uniform keeps precision;
// the pattern is noise, so the rare wrap is not visible.
const STREAK_TRAVEL_WRAP = 4096;
// A focus jump longer than this is a teleport: weights snap instead of easing.
const SNAP_DISTANCE = 60;
// Transparent draws sort by their group's renderOrder first; the water tiles
// sit in group 1 and the waterfall mist in group 2.
const ROOT_RENDER_ORDER = 3;
// Per-second rate the jungle mist's ground level follows the terrain.
const MIST_GROUND_RATE = 0.6;

function ease(current, target, rate, delta) {
  const eased = target + (current - target) * Math.exp(-rate * delta);
  return Math.abs(eased - target) < FIELD_VISIBILITY_THRESHOLD ? target : eased;
}

/**
 * The ambient layer: cheap particle fields, ridge plumes and breath that give
 * each biome its air (diamond dust and spindrift on the summits, blowing sand
 * and surf spray on the coast, pollen, seeds and fireflies over the meadow,
 * spores and light shafts in the jungle, midges and morning mist on the
 * water), plus the weights of the surface, fog and screen effects that live
 * inside other materials (ambientUniforms, jungle mist, frost, heat shimmer).
 *
 * Each effect's strength is its region's weight at the focus, times its
 * preset weight, times the preset's wind where it follows the wind, eased so
 * nothing switches on or off in one frame.
 */
export class AmbientEffectsSystem {
  constructor({ scene, config, terrainSampler, river = null, quality = 'high' }) {
    const levels = {
      sea: config.water?.sea?.enabled ? Number(config.water.sea.level) : undefined,
      lake: Number(config.water?.position?.[1]),
    };
    this.settings = resolveAmbientEffectsConfig(config.ambientEffects, levels);
    this.enabled = this.settings.enabled;
    this.fields = [];
    this.weights = null;
    this.values = {
      frost: 0, heatShimmer: 0, jungleMist: 0, snowStreaks: 0, sandStreaks: 0, grassGustSheen: 0, mistGround: 0,
    };
    if (!this.enabled) return;

    this.config = config;
    this.terrainSampler = terrainSampler;
    this.river = river;
    this.regions = resolveAmbientRegions(config);
    this.light = createSceneLight();
    this.puffTexture = createSprayPuffTexture({ seed: 9151 });
    this.regionTimer = Infinity;
    this.lastFocus = null;
    this.elapsed = 0;
    const snowWind = config.ground?.snow?.wind;
    this.snowWindDirection = snowWind ? snowWindVector(snowWind.angleDegrees, 1) : { x: 1, z: 0 };
    this.wind = { x: 0, z: 0 };

    this.root = new THREE.Group();
    this.root.name = 'Ambient effects';
    this.root.renderOrder = ROOT_RENDER_ORDER;
    const shader = terrainSampler.getShaderData();
    for (const settings of this.settings.fields) {
      const field = new AmbientParticleField({
        name: settings.name,
        settings,
        regions: this.regions,
        terrain: shader,
        light: this.light,
        sun: this.light.direction,
        puffTexture: this.puffTexture,
      });
      field.target = 0;
      this.fields.push(field);
      this.root.add(field.mesh);
    }

    const plumes = this.settings.plumes;
    if (plumes.enabled && this.regions.snowLine) {
      const { min, max } = terrainSampler.bounds;
      const anchors = findCrestAnchors((x, z) => terrainSampler.sampleHeight(x, z),
        { minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z }, {
          minHeight: plumes.minHeight,
          step: plumes.step,
          prominenceRadius: plumes.prominenceRadius,
          minProminence: plumes.minProminence,
          spacing: plumes.spacing,
          count: plumes.anchors,
        });
      this.plumeAnchors = anchors;
      if (anchors.length) {
        this.plumes = new RidgePlumes({
          settings: plumes, anchors, wind: this.snowWindDirection, light: this.light, puffTexture: this.puffTexture,
        });
        this.root.add(this.plumes.mesh);
      }
    }
    if (this.settings.breath.enabled) {
      this.breath = new BreathPuffs({ settings: this.settings.breath, light: this.light, puffTexture: this.puffTexture });
      this.root.add(this.breath.mesh);
    }
    this.setQuality(quality);
    scene.add(this.root);
  }

  setQuality(name) {
    if (!this.enabled) return;
    const share = this.settings.quality[name] ?? 1;
    for (const field of this.fields) field.setCount(field.settings.count * share);
  }

  /**
   * `focus` is the player (or the free-fly/tour camera); `presetName` the
   * active weather preset; `lighting` the environment's current light set;
   * `grassWind` the preset's { windIntensity, windDirection } in degrees;
   * `snowWeight` the eased snow-country weight; `player` the controller.
   */
  update(deltaSeconds, { focus, presetName, lighting, grassWind, snowWeight = 0, player = null }) {
    if (!this.enabled || !focus) return;
    const delta = Math.min(Math.max(Number(deltaSeconds) || 0, 0), MAX_STEP_SECONDS);
    this.elapsed += delta;
    if (lighting) this.light.update(lighting);

    const jumped = !this.lastFocus || Math.hypot(focus.x - this.lastFocus.x, focus.z - this.lastFocus.z) > SNAP_DISTANCE;
    this.lastFocus ??= { x: 0, z: 0 };
    this.lastFocus.x = focus.x;
    this.lastFocus.z = focus.z;
    this.regionTimer += delta;
    if (jumped || !this.weights || this.regionTimer >= this.settings.regionInterval) {
      this.regionTimer = 0;
      this.weights = sampleAmbientRegions(this.regions, focus.x, focus.z, {
        snowWeight,
        river: this.river,
        sampleHeight: (x, z) => this.terrainSampler.sampleHeight(x, z),
      });
      this.groundTarget = this.terrainSampler.sampleHeight(focus.x, focus.z);
    }
    // The jungle mist lies on the ground under the view, eased so it does not
    // bob with every step up or down.
    if (Number.isFinite(this.groundTarget)) {
      this.values.mistGround = jumped ? this.groundTarget
        : this.groundTarget + (this.values.mistGround - this.groundTarget) * Math.exp(-MIST_GROUND_RATE * delta);
    }
    // Snow country is eased by the environment already; take it every frame.
    this.weights.snow = THREE.MathUtils.clamp(snowWeight, 0, 1);

    const windiness = Math.max(0, Number(grassWind?.windIntensity) || 0) / this.settings.windReference;
    const direction = (Number(grassWind?.windDirection) || 0) * Math.PI / 180;
    const gust = 1 + this.settings.gust.strength * Math.sin(this.elapsed * TWO_PI / this.settings.gust.period)
      * (0.7 + 0.3 * Math.sin(this.elapsed * TWO_PI / (this.settings.gust.period * 0.37) + 1.3));
    ambientUniforms.windiness.value = windiness;
    ambientUniforms.windDirection.value.set(Math.cos(direction), Math.sin(direction));
    const rate = jumped ? Infinity : this.settings.fadeRate;
    const step = (current, target) => (rate === Infinity ? target : ease(current, target, rate, delta));

    for (const field of this.fields) {
      const s = field.settings;
      field.target = regionWeight(this.weights, s.regions) * presetWeight(s, presetName) * windFactor(windiness, s.windResponse);
      field.setIntensity(step(field.current, Math.min(field.target, 1)));
      const windSpeed = s.wind.speed * (1 + (Math.min(windiness, 2) - 1) * s.wind.follow) * gust;
      const axis = s.wind.source === 'snow' ? this.snowWindDirection : { x: Math.cos(direction), z: Math.sin(direction) };
      this.wind.x = axis.x * Math.max(windSpeed, 0);
      this.wind.z = axis.z * Math.max(windSpeed, 0);
      field.update(delta, focus, this.wind);
    }

    if (this.plumes) {
      const plumes = this.settings.plumes;
      this.plumes.setIntensity(step(this.plumes.current,
        Math.min(1, plumes.strength * presetWeight(plumes, presetName) * windFactor(windiness, plumes.windResponse))));
    }
    if (this.breath) {
      const breath = this.settings.breath;
      const cold = THREE.MathUtils.smoothstep(this.weights.snow, breath.minSnow, Math.min(1, breath.minSnow + 0.3));
      this.breath.update(delta, cold * breath.strength * presetWeight(breath, presetName), player);
    }

    // Effects inside other materials and passes.
    const weighted = (name, region) => {
      const effect = this.settings[name];
      if (!effect.enabled) return 0;
      return effect.strength * region * presetWeight(effect, presetName) * windFactor(windiness, effect.windResponse);
    };
    const values = this.values;
    values.snowStreaks = step(values.snowStreaks, weighted('snowStreaks', this.weights.snow));
    values.sandStreaks = step(values.sandStreaks, weighted('sandStreaks', this.weights.sand));
    values.grassGustSheen = step(values.grassGustSheen, weighted('grassGustSheen', this.weights.meadow));
    values.frost = step(values.frost, weighted('frost', this.weights.snow));
    values.heatShimmer = step(values.heatShimmer, weighted('heatShimmer', this.weights.sand));
    values.jungleMist = step(values.jungleMist, weighted('jungleMist', this.weights.jungle));
    ambientUniforms.snowStreaks.value = values.snowStreaks;
    ambientUniforms.sandStreaks.value = values.sandStreaks;
    ambientUniforms.grassGustSheen.value = values.grassGustSheen;
    const streakSpeed = Math.max(windiness, 0.15) * gust;
    ambientUniforms.snowStreakTravel.value = (ambientUniforms.snowStreakTravel.value + 3.2 * streakSpeed * delta)
      % STREAK_TRAVEL_WRAP;
    ambientUniforms.sandStreakTravel.value = (ambientUniforms.sandStreakTravel.value + 2.6 * streakSpeed * delta)
      % STREAK_TRAVEL_WRAP;
  }

  /** Snapshot for the debug console and the capture scripts. */
  getState() {
    if (!this.enabled) return { enabled: false };
    return {
      weights: { ...this.weights },
      fields: Object.fromEntries(this.fields.map((field) => [field.name, {
        intensity: Number(field.current.toFixed(3)), target: Number(field.target.toFixed(3)), count: field.mesh.count,
      }])),
      plumes: this.plumes ? { intensity: this.plumes.current, anchors: this.plumeAnchors.length } : null,
      breath: this.breath ? { intensity: this.breath.intensity, visible: this.breath.mesh.visible } : null,
      values: { ...this.values },
    };
  }

  dispose() {
    for (const field of this.fields) field.dispose();
    this.plumes?.dispose();
    this.breath?.dispose();
    this.puffTexture?.dispose();
    this.root?.removeFromParent();
    for (const name of ['snowStreaks', 'sandStreaks', 'grassGustSheen', 'windiness']) ambientUniforms[name].value = 0;
  }
}
