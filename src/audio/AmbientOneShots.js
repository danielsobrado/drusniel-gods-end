import * as THREE from 'three';
import { ShuffleBag, isPresetActive, randomIn, randomRange, regionGain } from './audioUtils.js';

const PITCH_MIN = 0.94;
const PITCH_MAX = 1.06;
// A group waits while its region weight is below this.
const MIN_WEIGHT = 0.05;
// Calls come further apart as the region weight falls, down to this share.
const MIN_DENSITY = 0.25;
const DEFAULT_VOICES = 2;
const TWO_PI = Math.PI * 2;

/**
 * Positional one-shots placed around the listener: birds, seagulls, single
 * breaking waves, frogs, cicadas. Each group names the regions and presets it
 * belongs to, and is scheduled only while the listener is in them. `place:
 * around` puts a call on a ring round the listener; `place: sea` puts it on the
 * water `seaward` world units out from the waterline, level with the listener, so
 * waves break on the shore rather than in the dunes. Each group cycles its
 * variations through a shuffle bag and reuses a small pool of voices; buffers
 * load on first use.
 */
export class AmbientOneShots {
  constructor({ listener, scene, config, loadBuffer, regions = null }) {
    this.listener = listener;
    this.scene = scene;
    this.config = config;
    this.loadBuffer = loadBuffer;
    this.regions = regions;
    this.masterVolume = config.masterVolume;
    this.environmentVolume = config.environmentVolume;
    this.groups = [];
    this.started = false;
    this.disposed = false;
  }

  init() {
    for (const definition of this.config.oneShots ?? []) {
      this.groups.push({
        config: definition,
        bag: new ShuffleBag(definition.sounds),
        voices: [],
        timer: randomIn(definition.delay, 5),
      });
    }
  }

  start() {
    if (this.disposed) return;
    this.started = true;
    for (const group of this.groups) group.timer = randomIn(group.config.delay, 5) * Math.random();
  }

  /** `listener` is the listener's world position, `weights` its region weights. */
  update(deltaSeconds, { preset, weights, listener }) {
    if (!this.started || this.disposed || !listener) return;
    for (const group of this.groups) {
      const definition = group.config;
      const weight = isPresetActive(definition, preset) ? regionGain(weights, definition) : 0;
      if (weight < MIN_WEIGHT) continue;
      group.timer -= deltaSeconds;
      if (group.timer > 0) continue;
      group.timer = randomIn(definition.delay, 5) / Math.max(weight, MIN_DENSITY);
      this.#play(group, weight, listener);
    }
  }

  #play(group, weight, listener) {
    const definition = group.config;
    let voice = group.voices.find((candidate) => !candidate.busy);
    if (!voice) {
      if (group.voices.length >= (definition.voices ?? DEFAULT_VOICES)) return;
      voice = this.#createVoice(definition);
      group.voices.push(voice);
    }
    if (!this.#place(definition, listener, voice.object.position)) return;
    const path = group.bag.next();
    if (!path) return;
    voice.busy = true;
    const volume = randomIn(definition.volume, 1) * weight;
    this.loadBuffer(path).then((buffer) => {
      if (!buffer || this.disposed || !this.started) {
        voice.busy = false;
        return;
      }
      const audio = voice.audio;
      audio.setBuffer(buffer);
      audio.playbackRate = randomRange(definition.pitch?.[0] ?? PITCH_MIN, definition.pitch?.[1] ?? PITCH_MAX);
      voice.volume = volume;
      audio.setVolume(volume * this.environmentVolume * this.masterVolume);
      audio.onEnded = () => {
        THREE.Audio.prototype.onEnded.call(audio);
        voice.busy = false;
      };
      audio.play();
    });
  }

  #createVoice(definition) {
    const object = new THREE.Object3D();
    const audio = new THREE.PositionalAudio(this.listener);
    audio.setLoop(false);
    audio.setRefDistance(definition.refDistance ?? 10);
    audio.setMaxDistance(definition.maxDistance ?? 200);
    audio.setRolloffFactor(definition.rolloffFactor ?? 1);
    object.add(audio);
    this.scene?.add(object);
    return { object, audio, busy: false, volume: 0 };
  }

  #place(definition, listener, out) {
    if (definition.place === 'sea') {
      const coastX = this.regions?.coastX(listener.z);
      if (coastX == null) return false;
      const along = definition.along ?? 40;
      out.set(
        coastX + randomIn(definition.seaward, 20),
        this.regions.seaLevel + randomIn(definition.height, 0),
        listener.z + randomRange(-along, along),
      );
      return true;
    }
    const angle = Math.random() * TWO_PI;
    const distance = randomIn(definition.distance, 20);
    out.set(
      listener.x + Math.cos(angle) * distance,
      listener.y + randomIn(definition.height, 0),
      listener.z + Math.sin(angle) * distance,
    );
    return true;
  }

  setVolumes({ masterVolume, environmentVolume }) {
    this.masterVolume = masterVolume;
    this.environmentVolume = environmentVolume;
    for (const group of this.groups) {
      for (const voice of group.voices) voice.audio.setVolume(voice.volume * environmentVolume * masterVolume);
    }
  }

  stopAll() {
    this.started = false;
    for (const group of this.groups) {
      for (const voice of group.voices) {
        if (voice.audio.isPlaying) voice.audio.stop();
        voice.busy = false;
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll();
    for (const group of this.groups) {
      for (const voice of group.voices) {
        voice.audio.disconnect();
        voice.object.removeFromParent();
      }
    }
    this.groups.length = 0;
  }
}
