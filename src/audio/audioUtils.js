import * as THREE from 'three';

export const RANDOM_EMITTER_RETRY_SECONDS = 1;
export const RANDOM_PITCH_MIN = 0.94;
export const RANDOM_PITCH_MAX = 1.06;

export function randomRange(min, max) {
  return THREE.MathUtils.randFloat(min, max);
}

export function randomInt(min, max) {
  return THREE.MathUtils.randInt(min, max);
}

export function isPresetActive(config, preset) {
  return config.preset == null && !config.presets
    || config.preset === preset
    || Array.isArray(config.presets) && config.presets.includes(preset);
}

export function animationPhaseCrossed(previous, current, phase, wrapped) {
  if (phase == null) return false;
  return wrapped
    ? previous < phase || current >= phase
    : previous < phase && current >= phase;
}

export function classifyTerrainBlend(value, threshold) {
  return value < threshold ? 'grass' : 'mud';
}

export function createBirdEmitterConfig(config, index) {
  const source = config.randomEmitters?.birds;
  const sounds = [...(source?.sounds ?? [])];
  for (let cursor = sounds.length - 1; cursor > 0; cursor -= 1) {
    const swap = Math.floor(Math.random() * (cursor + 1));
    [sounds[cursor], sounds[swap]] = [sounds[swap], sounds[cursor]];
  }
  const soundCount = sounds.length > 0
    ? randomInt(source.minSoundCount, Math.min(source.maxSoundCount, sounds.length))
    : 0;
  return {
    name: `bird${String(index + 1).padStart(2, '0')}`,
    position: [
      randomRange(source.position.x[0], source.position.x[1]),
      randomRange(source.position.y[0], source.position.y[1]),
      randomRange(source.position.z[0], source.position.z[1]),
    ],
    sounds: sounds.slice(0, soundCount),
    volume: randomRange(source.volume[0], source.volume[1]),
    radius: source.radius,
    refDistance: source.refDistance,
    maxDistance: source.maxDistance,
    rolloffFactor: source.rolloffFactor,
    minDelay: randomRange(source.minDelay[0], source.minDelay[1]),
    maxDelay: randomRange(source.maxDelay[0], source.maxDelay[1]),
  };
}
