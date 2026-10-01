import * as THREE from 'three';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';
import { AmbientAudioSystem } from './AmbientAudioSystem.js';
import { AmbientOneShots } from './AmbientOneShots.js';
import { FootstepAudioSystem } from './FootstepAudioSystem.js';

const DEFAULT_PRESET_FADE_SECONDS = 1.5;
const MIN_FADE_SECONDS = 0.01;
const DEFAULT_REGION_INTERVAL = 0.25;
const DEFAULT_REGION_FADE_RATE = 1.2;
// A camera move longer than this (a teleport) snaps the region weights.
const SNAP_DISTANCE = 60;

export class AudioSystem {
  /**
   * `regions` is an AudioRegions (or null): it gives the listener's region
   * weights, the waterline for sea one-shots and the footstep surface.
   */
  constructor({ camera, scene = null, controls = null, preset = 'sunny', waterMesh = null, waterSurface = null, regions = null, config }) {
    if (!camera) throw new Error('AudioSystem: camera is required.');
    this.camera = camera;
    this.scene = scene;
    this.controls = controls;
    this.regions = regions;
    this.config = config;
    this.audioConfig = config.audio;
    this.listener = new THREE.AudioListener();
    this.camera.add(this.listener);
    this.loader = new THREE.AudioLoader();
    // Decoded buffers by resolved URL, pending or done: every consumer of a
    // sound decodes it once. Only the buffer is shared; every sound keeps its
    // own nodes, gain and timing.
    this.buffers = new Map();
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
    this.listenerPosition = new THREE.Vector3();
    this.lastSamplePosition = null;
    this.regionTimer = Infinity;
    this.regionTarget = null;
    this.regionWeights = null;

    const loadBuffer = (path) => this.#loadBuffer(path);
    this.ambient = new AmbientAudioSystem({
      listener: this.listener,
      config: this.audioConfig,
      loadBuffer,
    });
    this.oneShots = new AmbientOneShots({
      listener: this.listener,
      scene,
      config: this.audioConfig,
      loadBuffer,
      regions,
    });
    this.footsteps = new FootstepAudioSystem({
      listener: this.listener,
      controls,
      scene,
      waterMesh,
      waterSurface,
      surfaceAt: regions ? (x, z, options) => regions.surfaceAt(x, z, options) : null,
      config: this.audioConfig.footsteps,
      levels: {
        masterVolume: this.masterVolume,
        environmentVolume: this.environmentVolume,
      },
      loadBuffer,
    });
    this.footsteps.setPreset(preset);
  }

  async init() {
    this.ambient.init(this.currentPreset);
    this.oneShots.init();
    await Promise.all([
      this.#loadTransitionSound(),
      this.footsteps.init(),
    ]);
    this.initialized = true;
    return this;
  }

  async #loadTransitionSound() {
    const path = this.audioConfig.transition?.sound;
    if (!path) return;
    const buffer = await this.#loadBuffer(path);
    if (buffer) this.transitionAudio.setBuffer(buffer);
  }

  #loadBuffer(path) {
    if (!path) return Promise.resolve(null);
    const url = assetUrl(path);
    let pending = this.buffers.get(url);
    if (!pending) {
      pending = this.loader.loadAsync(url).catch((error) => {
        logger.warn('Audio asset failed to load.', { path, error });
        return null;
      });
      this.buffers.set(url, pending);
      // A failure is not remembered, so a later request tries again.
      pending.then((buffer) => { if (!buffer && this.buffers.get(url) === pending) this.buffers.delete(url); });
    }
    // A buffer that finishes decoding after disposal is not handed out.
    return pending.then((buffer) => (this.disposed ? null : buffer));
  }

  async start() {
    if (this.disposed || !this.initialized) return false;
    if (this.started) return true;
    const context = THREE.AudioContext.getContext();
    if (context.state === 'suspended') await context.resume();
    if (this.disposed || context.state !== 'running') return false;
    this.enabled = true;
    this.started = true;
    this.#updateRegions(0);
    this.ambient.update(0, this.regionWeights);
    this.ambient.start(this.currentPreset);
    this.oneShots.start();
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
    this.ambient.activatePreset(name);
    this.footsteps.setPreset(name);
  }

  playTransition() {
    if (!this.enabled || !this.transitionAudio.buffer) return;
    if (this.transitionAudio.isPlaying) this.transitionAudio.stop();
    this.transitionAudio.setVolume((this.audioConfig.transition?.volume ?? 0) * this.masterVolume);
    this.transitionAudio.play();
  }

  update(deltaSeconds) {
    if (!this.initialized || !this.enabled || !this.started) return;
    this.#updatePresetTransition(deltaSeconds);
    this.#updateRegions(deltaSeconds);
    this.ambient.update(deltaSeconds, this.regionWeights);
    this.footsteps.update(deltaSeconds, this.enabled);
    this.oneShots.update(deltaSeconds, {
      preset: this.targetPreset,
      weights: this.regionWeights,
      listener: this.listenerPosition,
    });
  }

  // Samples the region weights at the listener a few times a second and eases
  // toward them every frame, so beds cross-fade as the landscape changes.
  #updateRegions(deltaSeconds) {
    this.camera.getWorldPosition(this.listenerPosition);
    if (!this.regions) return;
    const position = this.listenerPosition;
    const jumped = !this.lastSamplePosition
      || Math.hypot(position.x - this.lastSamplePosition.x, position.z - this.lastSamplePosition.z) > SNAP_DISTANCE;
    this.regionTimer += deltaSeconds;
    if (jumped || this.regionTimer >= (this.audioConfig.regionInterval ?? DEFAULT_REGION_INTERVAL)) {
      this.regionTimer = 0;
      this.regionTarget = this.regions.sample(position.x, position.z);
      this.lastSamplePosition ??= new THREE.Vector3();
      this.lastSamplePosition.copy(position);
    }
    if (jumped || !this.regionWeights) {
      this.regionWeights = { ...this.regionTarget };
      return;
    }
    const blend = 1 - Math.exp(-(this.audioConfig.regionFadeRate ?? DEFAULT_REGION_FADE_RATE) * deltaSeconds);
    for (const [name, target] of Object.entries(this.regionTarget)) {
      const current = this.regionWeights[name] ?? target;
      this.regionWeights[name] = current + (target - current) * blend;
    }
  }

  #updatePresetTransition(deltaSeconds) {
    if (!this.presetTransitioning) return;
    this.presetTransitionTime += deltaSeconds;
    const t = THREE.MathUtils.clamp(this.presetTransitionTime / this.presetFadeDuration, 0, 1);
    this.ambient.updatePresetVolumes(this.previousPreset, this.targetPreset, t);
    if (t < 1) return;
    const previous = this.previousPreset;
    this.currentPreset = this.targetPreset;
    this.presetTransitioning = false;
    this.ambient.deactivatePreset(previous, this.currentPreset);
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
    this.oneShots.setVolumes(levels);
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
      this.oneShots.start();
    }
  }

  stopAll() {
    this.footsteps?.update(0, false);
    this.ambient.stopAll();
    this.oneShots.stopAll();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll();
    if (this.transitionAudio.isPlaying) this.transitionAudio.stop();
    this.transitionAudio.disconnect();
    this.ambient.dispose();
    this.oneShots.dispose();
    this.footsteps.dispose();
    this.buffers.clear();
    this.camera.remove(this.listener);
  }
}
