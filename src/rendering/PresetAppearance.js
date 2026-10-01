import { Color, DataTexture, RGBAFormat, UnsignedByteType, Vector2 } from 'three';
import { uniform, texture } from 'three/tsl';
import { resolvePresetConfig } from '../config/resolvePresetConfig.js';

const states = new WeakMap();
const numericDefaults = { grassRootBrightness: 0.9, grassGradientPower: 2.6, grassFill: 0.06,
  grassBacklight: 0.85, groundTipMix: 0.12, foliageFill: 0.28, canopyTint: 0.9, directionalBend: 0,
  // Meadow density cues: how far up a blade the root shade reaches, per-blade
  // brightness spread, edge-on blades kept this wide on screen, and the ground
  // shade under standing grass (1 = the original sward tint).
  grassCanopyDepth: 0.3, grassValueJitter: 0, grassThicken: 0, groundSwardShade: 1,
  // LOD bands: 0 shrinks a retiring stem whole, 1 thins it at full height;
  // compensation widens the stems left standing (capped) to keep coverage.
  grassLodThinning: 0, grassLodCompensation: 0, grassLodWidenMax: 3 };
const colorDefaults = { dryRoot: '#6e6530', dryTip: '#c1b253', canopyShadow: '#286746', canopyLight: '#8cb75a' };

export function getPresetAppearance(config) {
  if (states.has(config)) return states.get(config);
  const style = config.cinematic?.style ?? {};
  const neutral = new DataTexture(new Uint8Array([0, 255, 128, 0]), 1, 1, RGBAFormat, UnsignedByteType);
  neutral.needsUpdate = true;
  const state = { enabled: uniform(0), field: neutral, neutral,
    fieldNode: texture(neutral),
    fieldMin: uniform(new Vector2()), fieldSize: uniform(new Vector2(1, 1)), fieldResolution: uniform(1) };
  for (const [name, value] of Object.entries(numericDefaults)) state[name] = uniform(style[name] ?? value);
  for (const [name, value] of Object.entries(colorDefaults)) state[name] = uniform(new Color(style[name] ?? value));
  states.set(config, state);
  return state;
}

export function bindReferenceField(config, field) {
  const state = getPresetAppearance(config);
  state.fieldNode.value = field?.texture ?? state.neutral;
  if (!field) return;
  state.fieldMin.value.set(field.bounds.min.x, field.bounds.min.z);
  state.fieldSize.value.set(field.bounds.max.x - field.bounds.min.x, field.bounds.max.z - field.bounds.min.z);
  state.fieldResolution.value = field.resolution;
}

export function sampleReferenceField(worldXZ, config) {
  const state = getPresetAppearance(config);
  const coordinates = worldXZ.sub(state.fieldMin).div(state.fieldSize).clamp(0, 1)
    .mul(state.fieldResolution.sub(1)).add(0.5).div(state.fieldResolution);
  return state.fieldNode.sample(coordinates);
}

export function setPresetAppearance(config, presetName) {
  const preset = resolvePresetConfig(config, presetName);
  const state = getPresetAppearance(config);
  const style = preset?.style ?? config.cinematic?.style ?? {};
  state.enabled.value = preset?.activeBiome ? 1 : 0;
  for (const [name, value] of Object.entries(numericDefaults)) state[name].value = style[name] ?? value;
  for (const [name, value] of Object.entries(colorDefaults)) state[name].value.set(style[name] ?? value);
}

export function disposePresetAppearance(config) {
  states.get(config)?.neutral.dispose();
  states.delete(config);
}
