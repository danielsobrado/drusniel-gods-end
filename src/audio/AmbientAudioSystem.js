import * as THREE from 'three';
import { isPresetActive, randomRange } from './audioUtils.js';

const EMITTER_FADE_SECONDS = 1;
const INITIAL_VARIATION_MIN = 2;
const INITIAL_VARIATION_MAX = 5;
const VARIATION_MIN = 3;
const VARIATION_MAX = 8;
const DEFAULT_VARIATION_SPEED = 0.15;

export class AmbientAudioSystem {
  constructor({ listener, scene, config, loadBuffer }) {
    this.listener = listener;
    this.scene = scene;
    this.config = config;
    this.loadBuffer = loadBuffer;
    this.ambient = [];
    this.emitters = [];
    this.masterVolume = config.masterVolume;
    this.ambientVolume = config.ambientVolume;
    this.environmentVolume = config.environmentVolume;
    this.started = false;
    this.currentPreset = null;
  }

  init(preset) {
    this.currentPreset = preset;
    this.#createAmbient(preset);
    this.#createEmitters();
  }

  #createAmbient(preset) {
    for (const definition of this.config.ambient ?? []) {
      const audio = new THREE.Audio(this.listener);
      audio.setLoop(definition.loop ?? true);
      const state = {
        config: definition,
        audio,
        presetMultiplier: this.getPresetMultiplier(definition, preset),
        baseVolume: 0,
        minVolume: 0,
        maxVolume: 0,
        currentVolume: 0,
        targetVolume: 0,
        variationTimer: randomRange(INITIAL_VARIATION_MIN, INITIAL_VARIATION_MAX),
      };
      this.#recalculateRange(state);
      this.#applyVolume(state);
      this.loadBuffer(definition.sound).then((buffer) => {
        if (!buffer) return;
        audio.setBuffer(buffer);
        if (this.started && isPresetActive(definition, this.currentPreset) && !audio.isPlaying) audio.play();
      });
      this.ambient.push(state);
    }
  }

  #createEmitters() {
    for (const definition of this.config.emitters ?? []) {
      const object = new THREE.Object3D();
      object.position.fromArray(definition.position);
      this.scene?.add(object);
      const audio = new THREE.PositionalAudio(this.listener);
      audio.setLoop(definition.loop ?? true);
      audio.setRefDistance(definition.refDistance ?? 10);
      audio.setMaxDistance(definition.maxDistance ?? 100);
      audio.setRolloffFactor(definition.rolloffFactor ?? 1);
      audio.setVolume(0);
      object.add(audio);
      const state = {
        config: definition,
        object,
        audio,
        targetVolume: definition.volume * this.environmentVolume * this.masterVolume,
        fadeInTime: 0,
      };
      this.emitters.push(state);
      this.loadBuffer(definition.sound).then((buffer) => {
        if (!buffer) return;
        audio.setBuffer(buffer);
        if (this.started && !audio.isPlaying) {
          state.fadeInTime = 0;
          audio.setVolume(0);
          audio.play();
        }
      });
    }
  }

  start(preset) {
    this.started = true;
    this.currentPreset = preset;
    for (const ambient of this.ambient) {
      if (ambient.audio.buffer && !ambient.audio.isPlaying && isPresetActive(ambient.config, preset)) {
        ambient.audio.play();
      }
    }
    for (const emitter of this.emitters) {
      if (!emitter.audio.buffer || emitter.audio.isPlaying) continue;
      emitter.fadeInTime = 0;
      emitter.audio.setVolume(0);
      emitter.audio.play();
    }
  }

  activatePreset(preset, enabled) {
    this.currentPreset = preset;
    if (!enabled) return;
    for (const ambient of this.ambient) {
      if (isPresetActive(ambient.config, preset)
        && ambient.audio.buffer
        && !ambient.audio.isPlaying) ambient.audio.play();
    }
  }

  deactivatePreset(previous, current) {
    for (const ambient of this.ambient) {
      if (!isPresetActive(ambient.config, previous)) continue;
      if (isPresetActive(ambient.config, current)) continue;
      if (ambient.audio.isPlaying) ambient.audio.stop();
    }
  }

  updatePresetVolumes(previous, target, t) {
    for (const ambient of this.ambient) {
      const from = this.getPresetMultiplier(ambient.config, previous);
      const to = this.getPresetMultiplier(ambient.config, target);
      ambient.presetMultiplier = THREE.MathUtils.lerp(from, to, t);
      this.#applyVolume(ambient);
    }
  }

  getPresetMultiplier(definition, preset) {
    if (!isPresetActive(definition, preset)) return 0;
    return this.config.presets?.[preset]?.ambient?.[definition.name]?.volumeMultiplier ?? 1;
  }

  update(deltaSeconds) {
    for (const ambient of this.ambient) {
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
      this.#applyVolume(ambient);
    }

    for (const emitter of this.emitters) {
      if (!emitter.audio.isPlaying || emitter.fadeInTime >= EMITTER_FADE_SECONDS) continue;
      emitter.fadeInTime += deltaSeconds / EMITTER_FADE_SECONDS;
      const factor = THREE.MathUtils.smoothstep(
        THREE.MathUtils.clamp(emitter.fadeInTime, 0, 1),
        0,
        1,
      );
      emitter.audio.setVolume(emitter.targetVolume * factor);
    }
  }

  setVolumes({ masterVolume, ambientVolume, environmentVolume }) {
    this.masterVolume = masterVolume;
    this.ambientVolume = ambientVolume;
    this.environmentVolume = environmentVolume;
    for (const ambient of this.ambient) {
      this.#recalculateRange(ambient);
      this.#applyVolume(ambient);
    }
    for (const emitter of this.emitters) {
      emitter.targetVolume = emitter.config.volume * this.environmentVolume * this.masterVolume;
      if (emitter.fadeInTime >= EMITTER_FADE_SECONDS) emitter.audio.setVolume(emitter.targetVolume);
    }
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

  #applyVolume(ambient) {
    ambient.audio.setVolume(ambient.currentVolume * ambient.presetMultiplier);
  }

  stopAll() {
    this.started = false;
    for (const ambient of this.ambient) if (ambient.audio.isPlaying) ambient.audio.stop();
    for (const emitter of this.emitters) if (emitter.audio.isPlaying) emitter.audio.stop();
  }

  dispose() {
    this.stopAll();
    for (const ambient of this.ambient) ambient.audio.disconnect();
    for (const emitter of this.emitters) {
      emitter.audio.disconnect();
      emitter.object.parent?.remove(emitter.object);
    }
    this.ambient.length = 0;
    this.emitters.length = 0;
  }
}
