import * as THREE from 'three';
import { isPresetActive, randomRange, regionGain, trimSilentEdges } from './audioUtils.js';

const INITIAL_VARIATION_MIN = 2;
const INITIAL_VARIATION_MAX = 5;
const VARIATION_MIN = 3;
const VARIATION_MAX = 8;
const DEFAULT_VARIATION_SPEED = 0.15;
// Below this gain a bed is stopped rather than played silently.
const AUDIBLE_GAIN = 0.001;

/**
 * Looping ambient beds. Each bed is weighted by the weather preset and, when
 * it names `regions`, by how far into those regions the listener is, so the
 * surf, the jungle and the alpine wind come and go with the landscape. A bed's
 * buffer is fetched the first time it would be heard, so regions the player
 * never visits cost no download or decode, and it starts at a random point of
 * its loop.
 */
export class AmbientAudioSystem {
  constructor({ listener, config, loadBuffer }) {
    this.listener = listener;
    this.config = config;
    this.loadBuffer = loadBuffer;
    this.ambient = [];
    this.masterVolume = config.masterVolume;
    this.ambientVolume = config.ambientVolume;
    this.started = false;
    this.disposed = false;
    this.currentPreset = null;
    this.weights = null;
  }

  init(preset) {
    this.currentPreset = preset;
    for (const definition of this.config.ambient ?? []) {
      const audio = new THREE.Audio(this.listener);
      audio.setLoop(definition.loop ?? true);
      audio.setVolume(0);
      const state = {
        config: definition,
        audio,
        requested: false,
        presetMultiplier: this.getPresetMultiplier(definition, preset),
        regionMultiplier: definition.regions?.length ? 0 : 1,
        baseVolume: 0,
        minVolume: 0,
        maxVolume: 0,
        currentVolume: 0,
        targetVolume: 0,
        variationTimer: randomRange(INITIAL_VARIATION_MIN, INITIAL_VARIATION_MAX),
      };
      this.#recalculateRange(state);
      this.ambient.push(state);
    }
  }

  start(preset) {
    this.started = true;
    this.currentPreset = preset;
    for (const ambient of this.ambient) this.#refresh(ambient);
  }

  activatePreset(preset) {
    this.currentPreset = preset;
  }

  deactivatePreset(_previous, current) {
    this.currentPreset = current;
    for (const ambient of this.ambient) {
      ambient.presetMultiplier = this.getPresetMultiplier(ambient.config, current);
      this.#refresh(ambient);
    }
  }

  updatePresetVolumes(previous, target, t) {
    for (const ambient of this.ambient) {
      const from = this.getPresetMultiplier(ambient.config, previous);
      const to = this.getPresetMultiplier(ambient.config, target);
      ambient.presetMultiplier = THREE.MathUtils.lerp(from, to, t);
    }
  }

  getPresetMultiplier(definition, preset) {
    if (!isPresetActive(definition, preset)) return 0;
    return this.config.presets?.[preset]?.ambient?.[definition.name]?.volumeMultiplier ?? 1;
  }

  /** `weights` are the listener's eased region weights. */
  update(deltaSeconds, weights = this.weights) {
    this.weights = weights;
    for (const ambient of this.ambient) {
      ambient.regionMultiplier = regionGain(weights, ambient.config);
      const variation = ambient.config.volumeVariation ?? 0;
      if (variation > 0) {
        ambient.variationTimer -= deltaSeconds;
        if (ambient.variationTimer <= 0) {
          ambient.targetVolume = randomRange(ambient.minVolume, ambient.maxVolume);
          ambient.variationTimer = randomRange(VARIATION_MIN, VARIATION_MAX);
        }
        const speed = ambient.config.variationSpeed ?? DEFAULT_VARIATION_SPEED;
        ambient.currentVolume = THREE.MathUtils.lerp(
          ambient.currentVolume,
          ambient.targetVolume,
          1 - Math.exp(-speed * deltaSeconds),
        );
      }
      this.#refresh(ambient);
    }
  }

  setVolumes({ masterVolume, ambientVolume }) {
    this.masterVolume = masterVolume;
    this.ambientVolume = ambientVolume;
    for (const ambient of this.ambient) {
      this.#recalculateRange(ambient);
      this.#refresh(ambient);
    }
  }

  #gain(ambient) {
    return ambient.currentVolume * ambient.presetMultiplier * ambient.regionMultiplier;
  }

  // Loads, starts, stops and sets the volume of a bed from its current gain.
  #refresh(ambient) {
    const gain = this.#gain(ambient);
    const audible = gain > AUDIBLE_GAIN;
    if (audible) this.#load(ambient);
    const audio = ambient.audio;
    if (this.started && audible && audio.buffer && !audio.isPlaying) {
      audio.offset = Math.random() * audio.buffer.duration;
      audio.play();
    } else if ((!this.started || !audible) && audio.isPlaying) {
      audio.stop();
    }
    audio.setVolume(gain);
  }

  #load(ambient) {
    if (ambient.requested) return;
    ambient.requested = true;
    this.loadBuffer(ambient.config.sound).then((buffer) => {
      if (!buffer || this.disposed) {
        ambient.requested = false;
        return;
      }
      ambient.audio.setBuffer(ambient.config.loop === false ? buffer : trimSilentEdges(buffer, this.listener.context));
      this.#refresh(ambient);
    });
  }

  #recalculateRange(ambient) {
    const variation = ambient.config.volumeVariation ?? 0;
    const baseVolume = ambient.config.volume * this.ambientVolume * this.masterVolume;
    ambient.baseVolume = baseVolume;
    ambient.minVolume = baseVolume * (1 - variation);
    ambient.maxVolume = baseVolume * (1 + variation);
    ambient.currentVolume = randomRange(ambient.minVolume, ambient.maxVolume);
    ambient.targetVolume = randomRange(ambient.minVolume, ambient.maxVolume);
  }

  stopAll() {
    this.started = false;
    for (const ambient of this.ambient) if (ambient.audio.isPlaying) ambient.audio.stop();
  }

  dispose() {
    this.disposed = true;
    this.stopAll();
    for (const ambient of this.ambient) ambient.audio.disconnect();
    this.ambient.length = 0;
  }
}
