import * as THREE from 'three';
import { ShuffleBag, animationPhaseCrossed, randomRange } from './audioUtils.js';

const MOVEMENT_EPSILON = 0.1;
const VELOCITY_EPSILON_SQ = 0.0001;
const WATER_HEIGHT_PADDING = 1.5;
const ONE_SHOT_CLEANUP_MS = 10;
const DEFAULT_SURFACE = 'grass';

/**
 * Footsteps timed to the walk and run clips' foot contacts. The surface under
 * the landing foot (grass, sand, snow, leaf litter, gravel, mud on wet paths,
 * water) comes from `surfaceAt(x, z, { wet })`. Each surface's variations are
 * dealt from a shuffle bag, with a little pitch and level spread, and are
 * loaded the first time that surface is stepped on (the `preload` surfaces
 * load up front).
 */
export class FootstepAudioSystem {
  constructor({ listener, controls, scene, waterMesh, waterSurface = null, surfaceAt = null, config, levels, loadBuffer }) {
    this.listener = listener;
    this.controls = controls;
    this.scene = scene;
    this.waterMesh = waterMesh;
    this.waterSurface = waterSurface;
    this.surfaceAt = surfaceAt;
    this.config = config;
    this.loadBuffer = loadBuffer;
    this.masterVolume = levels.masterVolume;
    this.environmentVolume = levels.environmentVolume;
    this.wet = false;
    this.waterBounds = waterMesh ? new THREE.Box3().setFromObject(waterMesh) : null;
    this.waterPosition = new THREE.Vector3();
    this.position = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.buffers = new Map();
    this.requested = new Set();
    this.bags = new Map();
    this.oneShots = new Map();
    this.state = {
      lastAnimation: null,
      previousTime: null,
      timeSinceLastStep: 1,
      lastFoot: null,
      lastPhase: null,
    };
  }

  async init() {
    await Promise.all((this.config.preload ?? [DEFAULT_SURFACE]).map((surface) => this.#loadSurface(surface)));
  }

  /** Paths turn to mud in the wet presets. */
  setPreset(name) {
    this.wet = Boolean(this.config.wetPresets?.includes(name));
  }

  #loadSurface(surface) {
    const sounds = this.config[surface]?.sounds ?? [];
    return Promise.all(sounds.map(async (path) => {
      if (this.requested.has(path) || this.buffers.has(path)) return;
      this.requested.add(path);
      const buffer = await this.loadBuffer(path);
      if (buffer && !this.disposed) this.buffers.set(path, buffer);
      else this.requested.delete(path);
    }));
  }

  update(deltaSeconds, enabled) {
    const state = this.state;
    state.timeSinceLastStep += deltaSeconds;
    const mixer = this.controls?.mixer ?? this.controls?.animation?.mixer;
    const activeAction = this.controls?.activeAction ?? this.controls?.animation?.current;
    if (!enabled || this.controls?.enabled === false || !mixer || !activeAction || deltaSeconds > 0.25) {
      this.#resetAnimationState();
      return;
    }
    if (!this.controls.grounded) {
      this.#resetAnimationState();
      return;
    }
    if (this.controls.moving === false || (this.controls.horizontalVelocity?.length() ?? 0) < MOVEMENT_EPSILON) {
      this.#resetAnimationState();
      return;
    }

    const animationName = this.controls.getCurrentAnimationName?.()
      ?? activeAction.getClip()?.name;
    if (!animationName) return;
    let movement = null;
    const walkClipName = this.controls.walkClipName ?? this.controls.animation?.names?.walk;
    const runClipName = this.controls.runClipName ?? this.controls.animation?.names?.run;
    if (walkClipName === runClipName && animationName === walkClipName) {
      movement = this.controls.running ? 'run' : 'walk';
    } else if (animationName === walkClipName) movement = 'walk';
    else if (animationName === runClipName) movement = 'run';
    if (!movement) {
      this.#resetAnimationState();
      return;
    }

    const clip = activeAction.getClip();
    if (!clip || clip.duration <= 0) return;
    const normalizedTime = THREE.MathUtils.clamp(activeAction.time, 0, clip.duration) / clip.duration;
    if (state.lastAnimation !== movement) {
      state.lastAnimation = movement;
      state.previousTime = normalizedTime;
      state.lastPhase = null;
      return;
    }
    if (state.previousTime === null) {
      state.previousTime = normalizedTime;
      return;
    }

    const previousTime = state.previousTime;
    const wrapped = normalizedTime < previousTime;
    const steps = this.controls.animation?.footsteps?.[movement] ?? this.config.animation?.[movement]?.steps;
    if (!steps) {
      state.previousTime = normalizedTime;
      return;
    }
    for (let index = 0; index < steps.length; index += 1) {
      if (animationPhaseCrossed(previousTime, normalizedTime, steps[index], wrapped)) {
        this.#animationFootContact(index, movement);
      }
    }
    state.previousTime = normalizedTime;
  }

  #animationFootContact(index, movement) {
    if (this.state.timeSinceLastStep < this.config.minStepInterval) return;
    this.state.lastFoot = index;
    this.state.timeSinceLastStep = 0;
    const surface = this.#isPlayerInWater() ? 'water' : this.#surfaceUnderFoot();
    if (surface) this.#play(surface, movement);
  }

  #resetAnimationState() {
    this.#stopOneShots();
    this.state.lastAnimation = null;
    this.state.previousTime = null;
    this.state.lastPhase = null;
    this.state.lastFoot = null;
  }

  // The foot lands a little ahead of the body when moving.
  #surfaceUnderFoot() {
    if (!this.controls || !this.scene) return null;
    const target = this.controls.getTarget?.() ?? this.controls.target ?? this.controls.root;
    if (!target) return null;
    target.getWorldPosition(this.position);
    const velocity = this.controls.horizontalVelocity;
    if (velocity?.lengthSq() > VELOCITY_EPSILON_SQ) {
      this.position.addScaledVector(this.direction.copy(velocity).normalize(), this.config.footstepPredictionDistance ?? 0);
    }
    return this.surfaceAt?.(this.position.x, this.position.z, { wet: this.wet }) ?? DEFAULT_SURFACE;
  }

  #play(requested, movement) {
    const surface = this.config[requested]?.sounds?.length ? requested : DEFAULT_SURFACE;
    const definition = this.config[surface];
    if (!definition?.sounds?.length) return;
    this.#loadSurface(surface);
    let bag = this.bags.get(surface);
    if (!bag) {
      bag = new ShuffleBag(definition.sounds);
      this.bags.set(surface, bag);
    }
    const buffer = this.buffers.get(bag.next());
    if (!buffer || !this.scene || this.disposed) return;
    const audio = new THREE.Audio(this.listener);
    audio.setBuffer(buffer);
    audio.setLoop(false);
    const spread = this.config.volumeSpread ?? 0;
    const gait = movement === 'run' ? this.config.runGain ?? 1 : 1;
    audio.setVolume(definition.volume * gait * randomRange(1 - spread, 1 + spread) * this.environmentVolume * this.masterVolume);
    audio.playbackRate = randomRange(this.config.minPitch, this.config.maxPitch);
    audio.play();
    const durationMs = buffer.duration / audio.playbackRate * 1000 + ONE_SHOT_CLEANUP_MS;
    const timer = window.setTimeout(() => {
      this.oneShots.delete(audio);
      if (audio.isPlaying) audio.stop();
      audio.disconnect();
    }, durationMs);
    this.oneShots.set(audio, timer);
  }

  #isPlayerInWater() {
    if (this.waterSurface && this.controls?.getPosition) {
      return this.waterSurface.containsPoint(this.controls.getPosition(), this.controls.metrics?.rootToFeet ?? 1.5);
    }
    if (!this.waterMesh || !this.waterBounds || !this.controls) return false;
    const position = this.controls.getCapsulePosition?.()
      ?? this.controls.physics?.getBodyPosition?.()
      ?? this.controls.getPosition?.();
    if (!position) return false;
    this.waterMesh.getWorldPosition(this.waterPosition);
    const dx = position.x - this.waterPosition.x;
    const dz = position.z - this.waterPosition.z;
    const radius = this.config.water.proximityDistance;
    if (dx * dx + dz * dz > radius * radius) return false;
    return position.y < this.waterPosition.y + WATER_HEIGHT_PADDING;
  }

  setVolumes({ masterVolume, environmentVolume }) {
    this.masterVolume = masterVolume;
    this.environmentVolume = environmentVolume;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.#stopOneShots();
    this.buffers.clear();
  }

  #stopOneShots() {
    for (const [audio, timer] of this.oneShots) {
      window.clearTimeout(timer);
      if (audio.isPlaying) audio.stop();
      audio.disconnect();
    }
    this.oneShots.clear();
  }
}
