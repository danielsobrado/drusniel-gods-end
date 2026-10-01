const DEFAULT_CAPTURE_INTERVAL_MS = 250;
const DEFAULT_SURFACE_GAP_MS = 50;

function captureInterval(value, fallback) {
  const configured = Number(value);
  return Number.isFinite(configured) && configured >= 0 ? configured : fallback;
}

/** Ultra updates planar reflections on a bounded cadence; cached qualities skip them. */
export class ReflectionBudget {
  constructor({ intervalMs = DEFAULT_CAPTURE_INTERVAL_MS } = {}) {
    this.intervalMs = captureInterval(intervalMs, DEFAULT_CAPTURE_INTERVAL_MS);
    this.reset();
  }

  setIntervalMs(intervalMs) {
    this.intervalMs = captureInterval(intervalMs, this.intervalMs);
  }

  reset() { this.lastTime = -Infinity; }

  shouldRender(camera, quality, now, visible = true) {
    if (!this.wouldRender(camera, quality, now, visible)) return false;
    this.markRendered(camera, now);
    return true;
  }

  wouldRender(_camera, quality, now, visible = true) {
    if (!visible) {
      this.reset();
      return false;
    }
    return quality === 'ultra' && now - this.lastTime >= this.intervalMs;
  }

  markRendered(_camera, now) {
    this.lastTime = now;
  }
}

/** Prevents multiple planar surfaces from stacking expensive captures in one frame. */
export class ReflectionCaptureGate {
  constructor({ minGapMs = DEFAULT_SURFACE_GAP_MS } = {}) {
    const configured = Number(minGapMs);
    this.minGapMs = Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_SURFACE_GAP_MS;
    this.reset();
  }

  reset() { this.lastTime = -Infinity; }

  wouldCapture(now) {
    return now - this.lastTime >= this.minGapMs;
  }

  markCaptured(now) {
    this.lastTime = now;
  }
}
