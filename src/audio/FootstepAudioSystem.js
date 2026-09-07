import * as THREE from 'three';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';
import { animationPhaseCrossed, classifyTerrainBlend, randomRange } from './audioUtils.js';

const MOVEMENT_EPSILON = 0.1;
const VELOCITY_EPSILON_SQ = 0.0001;
const WATER_HEIGHT_PADDING = 1.5;
const ONE_SHOT_CLEANUP_MS = 10;
const HALF = 0.5;

export class FootstepAudioSystem {
  constructor({ listener, controls, scene, waterMesh, config, levels, loadBuffer }) {
    this.listener = listener;
    this.controls = controls;
    this.scene = scene;
    this.waterMesh = waterMesh;
    this.config = config;
    this.loadBuffer = loadBuffer;
    this.masterVolume = levels.masterVolume;
    this.environmentVolume = levels.environmentVolume;
    this.waterBounds = waterMesh ? new THREE.Box3().setFromObject(waterMesh) : null;
    this.waterPosition = new THREE.Vector3();
    this.position = new THREE.Vector3();
    this.buffers = new Map();
    this.oneShots = new Map();
    this.lastSound = null;
    this.terrainBlendPixels = null;
    this.terrainBlendWidth = 0;
    this.terrainBlendHeight = 0;
    this.state = {
      lastAnimation: null,
      previousTime: null,
      timeSinceLastStep: 1,
      lastFoot: null,
      lastPhase: null,
    };
  }

  async init() {
    await Promise.all([
      this.#loadTerrainTexture(),
      this.#preloadSounds(),
    ]);
  }

  async #preloadSounds() {
    const paths = new Set();
    for (const surface of ['grass', 'mud', 'water']) {
      for (const path of this.config[surface]?.sounds ?? []) paths.add(path);
    }
    await Promise.all([...paths].map(async (path) => {
      const buffer = await this.loadBuffer(path);
      if (buffer && !this.disposed) this.buffers.set(path, buffer);
    }));
  }

  update(deltaSeconds, enabled) {
    const state = this.state;
    state.timeSinceLastStep += deltaSeconds;
    const mixer = this.controls?.mixer ?? this.controls?.animation?.mixer;
    const activeAction = this.controls?.activeAction ?? this.controls?.animation?.current;
    if (!enabled || !mixer || !activeAction) {
      this.#resetAnimationState();
      return;
    }
    if (!this.controls.grounded) {
      this.#resetAnimationState();
      return;
    }
    if ((this.controls.horizontalVelocity?.length() ?? 0) < MOVEMENT_EPSILON) {
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
    const steps = this.config.animation?.[movement]?.steps;
    if (!steps) {
      state.previousTime = normalizedTime;
      return;
    }
    for (let index = 0; index < steps.length; index += 1) {
      if (animationPhaseCrossed(previousTime, normalizedTime, steps[index], wrapped)) {
        this.#animationFootContact(index);
      }
    }
    state.previousTime = normalizedTime;
  }

  #animationFootContact(index) {
    if (this.state.timeSinceLastStep < this.config.minStepInterval) return;
    this.state.lastFoot = index;
    this.state.timeSinceLastStep = 0;
    if (this.#isPlayerInWater()) this.#playWaterFootstep();
    else this.#triggerFootstep();
  }

  #resetAnimationState() {
    this.state.lastAnimation = null;
    this.state.previousTime = null;
    this.state.lastPhase = null;
    this.state.lastFoot = null;
  }

  #triggerFootstep() {
    if (!this.controls || !this.scene) return;
    const target = this.controls.getTarget?.() ?? this.controls.target ?? this.controls.root;
    if (!target) return;
    target.getWorldPosition(this.position);
    const velocity = this.controls.horizontalVelocity;
    if (velocity?.lengthSq() > VELOCITY_EPSILON_SQ) {
      this.position.addScaledVector(
        velocity.clone().normalize(),
        this.config.footstepPredictionDistance,
      );
    }
    this.position.y -= this.controls.eyeHeight ?? this.controls.config?.player?.eyeHeight ?? HALF;
    this.#playAtPosition(this.position);
  }

  #playAtPosition(position) {
    const terrain = this.#getTerrain(position);
    const sounds = this.config[terrain]?.sounds;
    if (!sounds?.length) return;
    const index = this.#pickIndex(terrain, sounds.length);
    const buffer = this.buffers.get(sounds[index]);
    if (buffer) this.#createAudio(buffer, terrain);
  }

  #pickIndex(terrain, length) {
    let index = Math.floor(Math.random() * length);
    if (this.lastSound?.terrain === terrain && this.lastSound.index === index && length > 1) {
      index = (index + 1) % length;
    }
    this.lastSound = { terrain, index };
    return index;
  }

  #createAudio(buffer, terrain) {
    if (!this.scene || this.disposed) return;
    const surface = this.config[terrain];
    const audio = new THREE.Audio(this.listener);
    audio.setBuffer(buffer);
    audio.setLoop(false);
    audio.setVolume(surface.volume * this.environmentVolume * this.masterVolume);
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

  #getTerrain(position) {
    if (!this.terrainBlendPixels || !this.terrainBlendWidth || !this.terrainBlendHeight) return 'grass';
    const halfSize = this.config.terrainSize * HALF;
    const u = (position.x - this.config.terrainOffsetX + halfSize) / this.config.terrainSize;
    const v = (position.z - this.config.terrainOffsetZ + halfSize) / this.config.terrainSize;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 'grass';

    const x = u * (this.terrainBlendWidth - 1);
    const y = v * (this.terrainBlendHeight - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(this.terrainBlendWidth - 1, x0 + 1);
    const y1 = Math.min(this.terrainBlendHeight - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const sample = (px, py) => this.terrainBlendPixels[(py * this.terrainBlendWidth + px) * 4] / 255;
    const top = THREE.MathUtils.lerp(sample(x0, y0), sample(x1, y0), tx);
    const bottom = THREE.MathUtils.lerp(sample(x0, y1), sample(x1, y1), tx);
    return classifyTerrainBlend(
      THREE.MathUtils.lerp(top, bottom, ty),
      this.config.grassThreshold,
    );
  }

  #isPlayerInWater() {
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

  #playWaterFootstep() {
    const sounds = this.config.water?.sounds;
    if (!sounds?.length) return;
    const index = this.#pickIndex('water', sounds.length);
    const buffer = this.buffers.get(sounds[index]);
    if (buffer) this.#createAudio(buffer, 'water');
  }

  async #loadTerrainTexture() {
    const path = this.config.terrainTexture;
    if (!path || typeof Image === 'undefined' || typeof document === 'undefined') return;
    await new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          context.drawImage(image, 0, 0);
          this.terrainBlendPixels = context.getImageData(0, 0, image.width, image.height).data;
          this.terrainBlendWidth = image.width;
          this.terrainBlendHeight = image.height;
        } catch (error) {
          logger.warn('Footstep terrain mask could not be sampled.', error);
        }
        resolve();
      };
      image.onerror = () => resolve();
      image.src = assetUrl(path);
    });
  }

  setVolumes({ masterVolume, environmentVolume }) {
    this.masterVolume = masterVolume;
    this.environmentVolume = environmentVolume;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const [audio, timer] of this.oneShots) {
      window.clearTimeout(timer);
      if (audio.isPlaying) audio.stop();
      audio.disconnect();
    }
    this.oneShots.clear();
    this.buffers.clear();
    this.terrainBlendPixels = null;
  }
}
