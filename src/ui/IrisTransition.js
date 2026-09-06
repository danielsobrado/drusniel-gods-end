import { logger } from '../utils/logger.js';
import {
  IRIS_CLOSE_SECONDS,
  IRIS_OPEN_SECONDS,
  IRIS_RADIUS_VMAX,
  power4InOut,
} from './loadingStages.js';

// A circle wipe for scene changes: close to black, swap the world while it is
// hidden, open again. The environment no longer cross-fades, so the cut has to
// be covered rather than smoothed.
export class IrisTransition {
  constructor(root) {
    this.radius = IRIS_RADIUS_VMAX;
    this.animationFrame = null;
    this.pendingSwaps = new Map();
    this.finishAnimation = null;
    this.disposed = false;
    this.running = null;
    this.element = document.createElement('div');
    this.element.className = 'iris-overlay';
    this.element.setAttribute('aria-hidden', 'true');
    this.#setRadius(this.radius);
    root.appendChild(this.element);
  }

  // The only method callers need. Calls that arrive while a wipe is in flight
  // collapse per control: changing shape must not discard a pending preset.
  run(swap, key = 'default') {
    if (this.disposed) return Promise.resolve();
    this.pendingSwaps.set(key, swap);
    this.running ??= this.#drain().finally(() => { this.running = null; });
    return this.running;
  }

  async #drain() {
    const reducedMotion = this.#prefersReducedMotion();
    while (this.pendingSwaps.size && !this.disposed) {
      if (!reducedMotion) await this.close();
      // Anything queued while the iris was closing gets applied behind it too.
      while (this.pendingSwaps.size && !this.disposed) await this.#swap();
      if (!reducedMotion && !this.disposed) await this.open();
    }
  }

  // A failing swap must not leave the screen black, so it is logged rather than
  // thrown out of the drain loop.
  async #swap() {
    const [key, swap] = this.pendingSwaps.entries().next().value;
    this.pendingSwaps.delete(key);
    try {
      await swap();
    } catch (error) {
      logger.error('Iris transition swap failed; reopening.', error);
    }
  }

  close() {
    return this.#animate(0, IRIS_CLOSE_SECONDS);
  }

  open() {
    return this.#animate(IRIS_RADIUS_VMAX, IRIS_OPEN_SECONDS);
  }

  #animate(to, seconds) {
    this.#cancel();
    const from = this.radius;
    if (from === to || !this.element) return Promise.resolve();

    const startedAt = performance.now();
    const durationMs = seconds * 1000;

    return new Promise((resolve) => {
      this.finishAnimation = resolve;
      const tick = (now) => {
        const raw = Math.min(1, (now - startedAt) / durationMs);
        this.#setRadius(from + (to - from) * power4InOut(raw));
        if (raw < 1) {
          this.animationFrame = requestAnimationFrame(tick);
          return;
        }
        this.animationFrame = null;
        this.finishAnimation = null;
        resolve();
      };

      this.animationFrame = requestAnimationFrame(tick);
    });
  }

  #cancel() {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.finishAnimation?.();
    this.finishAnimation = null;
  }

  #setRadius(radius) {
    this.radius = radius;
    this.element?.style.setProperty('--r', `${radius}vmax`);
  }

  #prefersReducedMotion() {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  dispose() {
    this.disposed = true;
    this.#cancel();
    this.pendingSwaps.clear();
    this.element?.remove();
    this.element = null;
  }
}
