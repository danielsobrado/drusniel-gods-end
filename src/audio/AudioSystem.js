import * as THREE from 'three';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';
import { AmbientAudioSystem } from './AmbientAudioSystem.js';
import { FootstepAudioSystem } from './FootstepAudioSystem.js';
import { RandomAudioEmitters } from './RandomAudioEmitters.js';

const DEFAULT_PRESET_FADE_SECONDS = 1.5;
const MIN_FADE_SECONDS = 0.01;

export class AudioSystem {
  constructor({ camera, scene = null, controls = null, preset = 'sunny', waterMesh = null, waterSurface = null, config }) {
    if (!camera) throw new Error('AudioSystem: camera is required.');
    this.camera = camera;
    this.scene = scene;
    this.controls = controls;
    this.config = config;
    this.audioConfig = config.audio;
    this.listener = new THREE.AudioListener();
    this.camera.add(this.listener);
    this.loader = new THREE.AudioLoader();
    this.transitionAudio = new THREE.Audio(this.listener);
    this.masterVolume = this.audioConfig.masterVolume;
    this.ambientVolume = this.audioConfig.ambientVolume;
    this.environmentVolume = this.audioConfig.environmentVolume;
    this.enabled = false;
    this.initialized = false;
    this.started = false;
    this.currentPreset = preset;
    this.previousPreset = preset;
    this.targetPreset = preset;
    this.presetFadeDuration = this.audioConfig.presetFadeDuration ?? DEFAULT_PRESET_FADE_SECONDS;
    this.presetTransitionTime = 0;
    this.presetTransitioning = false;

    const loadBuffer = (path) => this.#loadBuffer(path);
    this.ambient = new AmbientAudioSystem({
      listener: this.listener,
      scene,
      config: this.audioConfig,
      loadBuffer,
    });
    this.randomEmitters = new RandomAudioEmitters({
      listener: this.listener,
      camera,
      scene,
      config: this.audioConfig,
      loadBuffer,
    });
    this.footsteps = new FootstepAudioSystem({
      listener: this.listener,
      controls,
      scene,
      waterMesh,
      waterSurface,
      config: this.audioConfig.footsteps,
      levels: {
        masterVolume: this.masterVolume,
        environmentVolume: this.environmentVolume,
      },
      loadBuffer,
    });
  }

  async init() {
    this.ambient.init(this.currentPreset);
    this.randomEmitters.init(this.currentPreset);
    await Promise.all([
      this.#loadTransitionSound(),
      this.footsteps.init(),
    ]);
    this.initialized = true;
    return this;
  }

  async #loadTransitionSound() {
    const path = this.config.assets.audio.transition;
    if (!path) return;
    const buffer = await this.#loadBuffer(path);
    if (buffer) this.transitionAudio.setBuffer(buffer);
  }

  async #loadBuffer(path) {
    if (!path) return null;
    try {
      return await this.loader.loadAsync(assetUrl(path));
    } catch (error) {
      logger.warn('Audio asset failed to load.', { path, error });
      return null;
    }
  }

  async start() {
    if (this.disposed || !this.initialized) return false;
    if (this.started) return true;
    const context = THREE.AudioContext.getContext();
    if (context.state === 'suspended') await context.resume();
    if (this.disposed || context.state !== 'running') return false;
    this.enabled = true;
    this.started = true;
    this.ambient.start(this.currentPreset);
    this.randomEmitters.start();
    return true;
  }

  setPreset(name, duration = this.audioConfig.presetFadeDuration ?? DEFAULT_PRESET_FADE_SECONDS) {
    if (!this.audioConfig.presets?.[name]) return;
    this.playTransition();
    if (name === this.currentPreset && !this.presetTransitioning) return;
    this.previousPreset = this.presetTransitioning ? this.targetPreset : this.currentPreset;
    this.targetPreset = name;
    this.presetFadeDuration = Math.max(MIN_FADE_SECONDS, duration);
    this.presetTransitionTime = 0;
    this.presetTransitioning = true;
    this.ambient.activatePreset(name, this.enabled);
    this.randomEmitters.activatePreset(name);
  }

  playTransition() {
    if (!this.enabled || !this.transitionAudio.buffer) return;
    if (this.transitionAudio.isPlaying) this.transitionAudio.stop();
    this.transitionAudio.setVolume(this.audioConfig.transitionVolume * this.masterVolume);
    this.transitionAudio.play();
  }

  update(deltaSeconds) {
    if (!this.initialized || !this.enabled || !this.started) return;
    this.#updatePresetTransition(deltaSeconds);
    this.ambient.update(deltaSeconds);
    this.footsteps.update(deltaSeconds, this.enabled);
    this.randomEmitters.update(deltaSeconds, this.currentPreset);
  }

  #updatePresetTransition(deltaSeconds) {
    if (!this.presetTransitioning) return;
    this.presetTransitionTime += deltaSeconds;
    const t = THREE.MathUtils.clamp(this.presetTransitionTime / this.presetFadeDuration, 0, 1);
    this.ambient.updatePresetVolumes(this.previousPreset, this.targetPreset, t);
    this.randomEmitters.updatePresetVolumes(this.previousPreset, this.targetPreset, t);
    if (t < 1) return;
    const previous = this.previousPreset;
    this.currentPreset = this.targetPreset;
    this.presetTransitioning = false;
    this.ambient.deactivatePreset(previous, this.currentPreset);
    this.randomEmitters.deactivatePreset(previous, this.currentPreset);
  }

  setMasterVolume(value) {
    this.masterVolume = THREE.MathUtils.clamp(value, 0, 1);
    this.#updateVolumes();
  }

  setAmbientVolume(value) {
    this.ambientVolume = THREE.MathUtils.clamp(value, 0, 1);
    this.#updateVolumes();
  }

  setEnvironmentVolume(value) {
    this.environmentVolume = THREE.MathUtils.clamp(value, 0, 1);
    this.#updateVolumes();
  }

  #updateVolumes() {
    const levels = {
      masterVolume: this.masterVolume,
      ambientVolume: this.ambientVolume,
      environmentVolume: this.environmentVolume,
    };
    this.ambient.setVolumes(levels);
    this.randomEmitters.setVolumes(levels);
    this.footsteps.setVolumes(levels);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this.stopAll();
      return;
    }
    if (this.started) {
      this.ambient.start(this.currentPreset);
      this.randomEmitters.start();
    }
  }

  stopAll() {
    this.footsteps?.update(0, false);
    this.ambient.stopAll();
    this.randomEmitters.stopAll();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll();
    if (this.transitionAudio.isPlaying) this.transitionAudio.stop();
    this.transitionAudio.disconnect();
    this.ambient.dispose();
    this.randomEmitters.dispose();
    this.footsteps.dispose();
    this.camera.remove(this.listener);
  }
}
