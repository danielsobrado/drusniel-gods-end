import * as THREE from 'three';
import {
  RANDOM_EMITTER_RETRY_SECONDS,
  RANDOM_PITCH_MAX,
  RANDOM_PITCH_MIN,
  createBirdEmitterConfig,
  isPresetActive,
  randomRange,
} from './audioUtils.js';

export class RandomAudioEmitters {
  constructor({ listener, camera, scene, config, loadBuffer }) {
    this.listener = listener;
    this.camera = camera;
    this.scene = scene;
    this.config = config;
    this.loadBuffer = loadBuffer;
    this.masterVolume = config.masterVolume;
    this.environmentVolume = config.environmentVolume;
    this.randomEmitters = [];
    this.presetRandomEmitters = [];
    this.started = false;
    this.disposed = false;
  }

  init(preset) {
    this.#createBirdEmitters(preset);
    this.#createPresetEmitters(preset);
  }

  #createBirdEmitters(preset) {
    const definition = this.config.randomEmitters?.birds;
    if (!definition) return;
    for (let index = 0; index < definition.count; index += 1) {
      const emitterConfig = createBirdEmitterConfig(this.config, index);
      this.randomEmitters.push(this.#createEmitter(
        emitterConfig,
        this.getPresetMultiplier(preset),
      ));
    }
  }

  #createPresetEmitters(preset) {
    for (const definition of this.config.presetRandomEmitters ?? []) {
      this.presetRandomEmitters.push(this.#createEmitter(
        definition,
        isPresetActive(definition, preset) ? 1 : 0,
      ));
    }
  }

  #createEmitter(definition, presetMultiplier) {
    const object = new THREE.Object3D();
    object.position.fromArray(definition.position);
    this.scene?.add(object);
    return {
      config: definition,
      object,
      audio: null,
      cleanupTimer: null,
      loadedBuffers: new Map(),
      playing: false,
      presetMultiplier,
      nextPlayTime: this.#randomDelay(definition.minDelay, definition.maxDelay),
    };
  }

  start() {
    if (this.disposed) return;
    this.started = true;
    for (const emitter of [...this.randomEmitters, ...this.presetRandomEmitters]) {
      emitter.nextPlayTime = this.#randomDelay(emitter.config.minDelay, emitter.config.maxDelay);
    }
  }

  activatePreset(preset) {
    for (const emitter of this.presetRandomEmitters) {
      if (isPresetActive(emitter.config, preset)) {
        emitter.nextPlayTime = this.#randomDelay(emitter.config.minDelay, emitter.config.maxDelay);
      }
    }
  }

  deactivatePreset(previous, current) {
    for (const emitter of this.presetRandomEmitters) {
      if (!isPresetActive(emitter.config, previous) || isPresetActive(emitter.config, current)) continue;
      this.#releaseAudio(emitter);
    }
  }

  updatePresetVolumes(previous, target, t) {
    const fromRandom = this.getPresetMultiplier(previous);
    const toRandom = this.getPresetMultiplier(target);
    for (const emitter of this.randomEmitters) {
      emitter.presetMultiplier = THREE.MathUtils.lerp(fromRandom, toRandom, t);
    }

    for (const emitter of this.presetRandomEmitters) {
      const fromActive = isPresetActive(emitter.config, previous);
      const toActive = isPresetActive(emitter.config, target);
      if (fromActive && toActive) emitter.presetMultiplier = 1;
      else if (fromActive) emitter.presetMultiplier = 1 - t;
      else if (toActive) emitter.presetMultiplier = t;
      else emitter.presetMultiplier = 0;
      emitter.audio?.setVolume(this.#volume(emitter));
    }
  }

  update(deltaSeconds, preset) {
    if (!this.started || this.disposed) return;
    for (const emitter of this.randomEmitters) this.#updateRandomEmitter(emitter, deltaSeconds, preset);
    for (const emitter of this.presetRandomEmitters) this.#updatePresetEmitter(emitter, deltaSeconds);
  }

  #updateRandomEmitter(emitter, deltaSeconds, preset) {
    if (emitter.presetMultiplier <= 0 || emitter.playing) return;
    emitter.nextPlayTime -= deltaSeconds;
    if (emitter.nextPlayTime > 0) return;
    if (this.camera.position.distanceTo(emitter.object.position) > emitter.config.radius) {
      emitter.nextPlayTime = RANDOM_EMITTER_RETRY_SECONDS;
      return;
    }
    this.#playRandomSound(emitter);
    const delayMultiplier = this.getDelayMultiplier(preset);
    emitter.nextPlayTime = this.#randomDelay(
      emitter.config.minDelay * delayMultiplier,
      emitter.config.maxDelay * delayMultiplier,
    );
  }

  #updatePresetEmitter(emitter, deltaSeconds) {
    if (emitter.presetMultiplier <= 0 || emitter.playing) return;
    emitter.nextPlayTime -= deltaSeconds;
    if (emitter.nextPlayTime > 0) return;
    if (this.camera.position.distanceTo(emitter.object.position) > emitter.config.radius) {
      emitter.nextPlayTime = RANDOM_EMITTER_RETRY_SECONDS;
      return;
    }
    this.#playRandomSound(emitter);
    emitter.nextPlayTime = this.#randomDelay(emitter.config.minDelay, emitter.config.maxDelay);
  }

  #playRandomSound(emitter) {
    const sounds = emitter.config.sounds;
    if (!this.started || !sounds?.length) return;
    const path = sounds[Math.floor(Math.random() * sounds.length)];
    const cached = emitter.loadedBuffers.get(path);
    if (cached) {
      this.#playBuffer(emitter, cached);
      return;
    }
    this.loadBuffer(path).then((buffer) => {
      if (!buffer || this.disposed) return;
      emitter.loadedBuffers.set(path, buffer);
      if (this.started) this.#playBuffer(emitter, buffer);
    });
  }

  #playBuffer(emitter, buffer) {
    if (!this.started || this.disposed || emitter.playing || emitter.presetMultiplier <= 0) return;
    const audio = new THREE.PositionalAudio(this.listener);
    audio.setBuffer(buffer);
    audio.setLoop(false);
    audio.setRefDistance(emitter.config.refDistance ?? 5);
    audio.setMaxDistance(emitter.config.maxDistance ?? 100);
    audio.setRolloffFactor(emitter.config.rolloffFactor ?? 1);
    audio.setVolume(this.#volume(emitter));
    audio.playbackRate = randomRange(RANDOM_PITCH_MIN, RANDOM_PITCH_MAX);
    emitter.object.add(audio);
    emitter.audio = audio;
    emitter.playing = true;
    audio.play();
    const durationMs = buffer.duration / audio.playbackRate * 1000;
    emitter.cleanupTimer = window.setTimeout(() => {
      emitter.cleanupTimer = null;
      if (emitter.audio === audio) this.#releaseAudio(emitter);
    }, durationMs);
  }

  #releaseAudio(emitter) {
    if (emitter.cleanupTimer !== null) window.clearTimeout(emitter.cleanupTimer);
    emitter.cleanupTimer = null;
    const audio = emitter.audio;
    emitter.audio = null;
    emitter.playing = false;
    if (!audio) return;
    if (audio.isPlaying) audio.stop();
    audio.removeFromParent();
    audio.disconnect();
  }

  getPresetMultiplier(preset) {
    return this.config.presets?.[preset]?.randomEmitters?.volumeMultiplier ?? 1;
  }

  getDelayMultiplier(preset) {
    return this.config.presets?.[preset]?.randomEmitters?.delayMultiplier ?? 1;
  }

  #volume(emitter) {
    return emitter.config.volume
      * this.environmentVolume
      * this.masterVolume
      * (emitter.presetMultiplier ?? 1);
  }

  setVolumes({ masterVolume, environmentVolume }) {
    this.masterVolume = masterVolume;
    this.environmentVolume = environmentVolume;
    for (const emitter of [...this.randomEmitters, ...this.presetRandomEmitters]) {
      emitter.audio?.setVolume(this.#volume(emitter));
    }
  }

  stopAll() {
    this.started = false;
    for (const emitter of [...this.randomEmitters, ...this.presetRandomEmitters]) {
      this.#releaseAudio(emitter);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll();
    for (const emitter of [...this.randomEmitters, ...this.presetRandomEmitters]) {
      emitter.object.parent?.remove(emitter.object);
      emitter.loadedBuffers.clear();
    }
    this.randomEmitters.length = 0;
    this.presetRandomEmitters.length = 0;
  }

  #randomDelay(min, max) {
    return randomRange(min, max);
  }
}
