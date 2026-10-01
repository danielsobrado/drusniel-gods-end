import * as THREE from 'three';

export { resolveSnowAtmosphereConfig } from '../config/resolveSnowAtmosphereConfig.js';

// Regional light over snow country. Snowflow's look rests on a low, warm sun
// raking across the snow under a cool sky, with haze in the distance; the
// presets are lit for the meadow. This blends each preset toward that look by
// how far the view is up the mountain, relative to the preset rather than to
// fixed colours, so a moonlit or rainy summit stays moonlit or rainy.

const LUMINANCE = new THREE.Vector3(0.2126, 0.7152, 0.0722);
const MAX_STEP_SECONDS = 0.1;
const UP_EPSILON = 1e-6;

/** How far a ground height is into snow country, 0..1. */
export function snowRegionWeight(height, settings) {
  if (!settings || !Number.isFinite(height)) return 0;
  return THREE.MathUtils.smoothstep(height, settings.startHeight, settings.fullHeight);
}

export function createSnowAtmosphereState() {
  return {
    lighting: {
      color: new THREE.Color(),
      directionalIntensity: 0,
      position: new THREE.Vector3(),
      hemisphereSkyColor: new THREE.Color(),
      hemisphereGroundColor: new THREE.Color(),
      hemisphereIntensity: 0,
      ambientColor: new THREE.Color(),
      ambientIntensity: 0,
      environmentIntensity: 0,
    },
    sky: {
      horizonColor: new THREE.Color(),
      zenithColor: new THREE.Color(),
      fogColor: new THREE.Color(),
      sunPosition: new THREE.Vector3(),
    },
    fogColor: new THREE.Color(),
    fogDensity: 0,
    exposureScale: 1,
    occlusionScale: 1,
  };
}

const _grey = new THREE.Color();
const _target = new THREE.Color();

function desaturate(source, amount, target) {
  const luminance = source.r * LUMINANCE.x + source.g * LUMINANCE.y + source.b * LUMINANCE.z;
  return target.copy(source).lerp(_grey.setScalar(luminance), amount);
}

// Lowers a direction's elevation toward `elevation` without turning it, and
// never raises a sun that is already lower.
function lowerSun(source, elevation, weight, target) {
  const length = source.length();
  const horizontal = Math.hypot(source.x, source.z);
  if (!(length > 0)) return target.copy(source);
  const current = Math.atan2(source.y, horizontal);
  const lowered = THREE.MathUtils.lerp(current, Math.min(current, elevation), weight);
  const x = horizontal > UP_EPSILON ? source.x / horizontal : 1;
  const z = horizontal > UP_EPSILON ? source.z / horizontal : 0;
  return target.set(
    x * Math.cos(lowered) * length,
    Math.sin(lowered) * length,
    z * Math.cos(lowered) * length,
  );
}

/**
 * The preset snapshot blended toward snow-country light by `weight`. Writes
 * into `out` (from createSnowAtmosphereState) and returns it. With no settings
 * or a zero weight the result is the preset itself.
 */
export function blendSnowAtmosphere(preset, settings, weight, out = createSnowAtmosphereState()) {
  const w = settings ? THREE.MathUtils.clamp(Number(weight) || 0, 0, 1) : 0;
  const source = preset.lighting;
  const lighting = out.lighting;
  const lerp = (from, scale) => from * THREE.MathUtils.lerp(1, scale ?? 1, w);

  lighting.directionalIntensity = lerp(source.directionalIntensity, settings?.sunIntensityScale);
  lighting.hemisphereIntensity = lerp(source.hemisphereIntensity, settings?.hemisphereIntensityScale);
  lighting.ambientIntensity = lerp(source.ambientIntensity, settings?.ambientIntensityScale);
  lighting.environmentIntensity = lerp(source.environmentIntensity, settings?.environmentIntensityScale);
  out.fogDensity = lerp(preset.sky.fogDensity, settings?.fogDensityScale);
  out.exposureScale = THREE.MathUtils.lerp(1, settings?.exposureScale ?? 1, w);
  out.occlusionScale = THREE.MathUtils.lerp(1, settings?.occlusionScale ?? 1, w);

  lighting.color.copy(source.color);
  lighting.position.copy(source.position);
  lighting.hemisphereSkyColor.copy(source.hemisphereSkyColor);
  lighting.hemisphereGroundColor.copy(source.hemisphereGroundColor);
  lighting.ambientColor.copy(source.ambientColor);
  out.sky.horizonColor.copy(preset.sky.horizonColor);
  out.sky.zenithColor.copy(preset.sky.zenithColor);
  out.sky.sunPosition.copy(preset.sky.sunPosition);
  out.fogColor.copy(preset.sky.fogColor);
  out.sky.fogColor.copy(preset.sky.fogColor);
  if (w === 0) return out;

  // A low sun through more air: lower, warmer, and relatively stronger against
  // a sky that no longer has green meadow under it to bounce.
  lighting.color.lerp(_target.copy(source.color).multiply(settings.sunWarmth), w);
  lowerSun(source.position, settings.sunElevation, w, lighting.position);
  lowerSun(preset.sky.sunPosition, settings.sunElevation, w, out.sky.sunPosition);

  lighting.hemisphereSkyColor.lerp(_target.copy(source.hemisphereSkyColor).multiply(settings.skyTint), w);
  // The ground is snow now: it returns the sky and some of the sun.
  _target.copy(source.hemisphereSkyColor).lerp(source.color, settings.sunBounce).multiply(settings.groundBounce);
  lighting.hemisphereGroundColor.lerp(_target, w);
  lighting.ambientColor.lerp(source.hemisphereSkyColor, w * settings.ambientCooling);

  desaturate(preset.sky.fogColor, settings.fogDesaturation, _target).multiply(settings.fogTint);
  out.fogColor.lerp(_target, w);
  out.sky.fogColor.copy(out.fogColor);
  desaturate(preset.sky.horizonColor, settings.horizonDesaturation, _target);
  out.sky.horizonColor.lerp(_target, w);
  // Thin, cold, hazy air: the zenith loses saturation and takes some haze.
  desaturate(preset.sky.zenithColor, settings.zenithDesaturation, _target).lerp(out.fogColor, settings.zenithHaze);
  out.sky.zenithColor.lerp(_target, w);
  return out;
}

/**
 * Eased snow-country weight for the view's focus. A jump further than
 * `snapDistance` (a teleport) snaps instead of easing, so the sun does not
 * visibly sweep after arriving on the summit.
 */
export class SnowRegionTracker {
  constructor({ terrainSampler, settings }) {
    this.terrainSampler = terrainSampler;
    this.settings = settings;
    this.weight = 0;
    this.last = null;
  }

  update(deltaSeconds, focus) {
    if (!this.settings || !focus || !this.terrainSampler) return this.weight;
    const height = this.terrainSampler.sampleHeight(focus.x, focus.z);
    const target = snowRegionWeight(height, this.settings);
    const jumped = !this.last
      || Math.hypot(focus.x - this.last.x, focus.z - this.last.z) > this.settings.snapDistance;
    if (jumped) {
      this.weight = target;
    } else {
      const delta = Math.min(Math.max(Number(deltaSeconds) || 0, 0), MAX_STEP_SECONDS);
      this.weight = target + (this.weight - target) * Math.exp(-this.settings.fadeRate * delta);
      if (Math.abs(this.weight - target) < 1e-4) this.weight = target;
    }
    this.last ??= { x: 0, z: 0 };
    this.last.x = focus.x;
    this.last.z = focus.z;
    return this.weight;
  }
}
