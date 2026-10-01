import * as THREE from 'three';

export function randomRange(min, max) {
  return THREE.MathUtils.randFloat(min, max);
}

/** A [min, max] pair or a single number, as a random value in that range. */
export function randomIn(value, fallback = 0) {
  if (Array.isArray(value)) return randomRange(value[0], value[1] ?? value[0]);
  return Number.isFinite(value) ? value : fallback;
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

/** The loudest of the named region weights; 1 when no regions are named. */
export function regionWeight(weights, names) {
  if (!names?.length) return 1;
  let best = 0;
  for (const name of names) best = Math.max(best, weights?.[name] ?? 0);
  return best;
}

/**
 * How much a bed or one-shot group belongs where the listener is: its
 * `regions` weight, faded out by its `excludeRegions` (frogs by a stream in
 * snow country, say).
 */
export function regionGain(weights, definition) {
  const excluded = definition.excludeRegions?.length ? regionWeight(weights, definition.excludeRegions) : 0;
  return regionWeight(weights, definition.regions) * (1 - excluded);
}

/**
 * Deals items in a shuffled order and reshuffles once all are dealt, never
 * dealing the same item twice in a row across the reshuffle. Variations cycle
 * instead of repeating at random.
 */
export class ShuffleBag {
  constructor(items) {
    this.items = [...(items ?? [])];
    this.order = [];
    this.last = null;
  }

  next() {
    if (!this.items.length) return null;
    if (!this.order.length) {
      this.order = [...this.items];
      for (let i = this.order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
      }
      if (this.order.length > 1 && this.order[this.order.length - 1] === this.last) {
        [this.order[0], this.order[this.order.length - 1]] = [this.order[this.order.length - 1], this.order[0]];
      }
    }
    this.last = this.order.pop();
    return this.last;
  }
}

// Longest run of encoder padding trimmed from either end of a loop.
const MAX_PADDING_FRAMES = 4096;
const PADDING_LEVEL = 1e-4;

/**
 * Loops are authored to run seamlessly, but some decoders keep the MP3
 * encoder's priming and padding silence, which would click once per cycle.
 * Returns the buffer without near-silent frames at either end.
 */
export function trimSilentEdges(buffer, context) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const silent = (frame) => channels.every((data) => Math.abs(data[frame]) < PADDING_LEVEL);
  let start = 0;
  while (start < MAX_PADDING_FRAMES && start < buffer.length - 1 && silent(start)) start += 1;
  let end = buffer.length;
  while (buffer.length - end < MAX_PADDING_FRAMES && end > start + 1 && silent(end - 1)) end -= 1;
  if (start === 0 && end === buffer.length) return buffer;
  const trimmed = context.createBuffer(buffer.numberOfChannels, end - start, buffer.sampleRate);
  channels.forEach((data, i) => trimmed.getChannelData(i).set(data.subarray(start, end)));
  return trimmed;
}
