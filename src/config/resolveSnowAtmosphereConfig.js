import { Color } from 'three';

const DEGREES = Math.PI / 180;
const PREFIX = 'ground.snow.atmosphere';

function finite(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${PREFIX}.${name} must be a finite number.`);
  return number;
}

function nonNegative(value, name) {
  const number = finite(value, name);
  if (number < 0) throw new Error(`${PREFIX}.${name} must be zero or greater.`);
  return number;
}

function unit(value, name) {
  const number = finite(value, name);
  if (number < 0 || number > 1) throw new Error(`${PREFIX}.${name} must be in [0, 1].`);
  return number;
}

function colorValue(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${PREFIX}.${name} must be a color string.`);
  return new Color(value);
}

// Snow-country light (see src/world/SnowAtmosphere.js). Returns null when the
// snow or the atmosphere is switched off.
export function resolveSnowAtmosphereConfig(config) {
  const settings = config?.ground?.snow?.enabled ? config.ground.snow.atmosphere : null;
  if (!settings || settings.enabled === false) return null;
  const startHeight = finite(settings.startHeight, 'startHeight');
  const fullHeight = finite(settings.fullHeight, 'fullHeight');
  if (!(fullHeight > startHeight)) throw new Error(`${PREFIX}.fullHeight must be greater than startHeight.`);
  const sunElevationDegrees = finite(settings.sunElevationDegrees, 'sunElevationDegrees');
  if (sunElevationDegrees <= 0 || sunElevationDegrees >= 90) {
    throw new Error(`${PREFIX}.sunElevationDegrees must be between 0 and 90.`);
  }
  return {
    startHeight,
    fullHeight,
    fadeRate: nonNegative(settings.fadeRate, 'fadeRate'),
    snapDistance: nonNegative(settings.snapDistance, 'snapDistance'),
    sunElevation: sunElevationDegrees * DEGREES,
    sunIntensityScale: nonNegative(settings.sunIntensityScale, 'sunIntensityScale'),
    sunWarmth: colorValue(settings.sunWarmth, 'sunWarmth'),
    hemisphereIntensityScale: nonNegative(settings.hemisphereIntensityScale, 'hemisphereIntensityScale'),
    ambientIntensityScale: nonNegative(settings.ambientIntensityScale, 'ambientIntensityScale'),
    environmentIntensityScale: nonNegative(settings.environmentIntensityScale, 'environmentIntensityScale'),
    skyTint: colorValue(settings.skyTint, 'skyTint'),
    groundBounce: colorValue(settings.groundBounce, 'groundBounce'),
    sunBounce: unit(settings.sunBounce, 'sunBounce'),
    ambientCooling: unit(settings.ambientCooling, 'ambientCooling'),
    fogTint: colorValue(settings.fogTint, 'fogTint'),
    fogDesaturation: unit(settings.fogDesaturation, 'fogDesaturation'),
    fogDensityScale: nonNegative(settings.fogDensityScale, 'fogDensityScale'),
    horizonDesaturation: unit(settings.horizonDesaturation, 'horizonDesaturation'),
    zenithDesaturation: unit(settings.zenithDesaturation, 'zenithDesaturation'),
    zenithHaze: unit(settings.zenithHaze, 'zenithHaze'),
    exposureScale: nonNegative(settings.exposureScale, 'exposureScale'),
    occlusionScale: unit(settings.occlusionScale, 'occlusionScale'),
  };
}
