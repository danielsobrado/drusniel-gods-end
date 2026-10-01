// Deferred work (vegetation rebuild jobs, foliage view-cull repacks) used fixed
// budgets of 2 ms and 1.5 ms a frame. At 144 Hz the whole frame is 6.94 ms, so
// whenever that work ran on top of a normal frame the frame missed its slot:
// it was the most common mark in the slowest frames while moving. This tracks
// what the rest of the frame costs and hands deferred work only the time left.
// Each consumer keeps a floor, so work still advances under load and simply
// finishes over more frames; the starvation guards in the job scheduler stay.
export const DEFAULT_FRAME_BUDGET_MS = 1000 / 144;

export class FrameSlack {
  constructor({
    targetMs = DEFAULT_FRAME_BUDGET_MS,
    // Kept free for the browser, GC and timing noise.
    reserveMs = 0.5,
    smoothing = 0.1,
    now = () => performance.now(),
  } = {}) {
    this.targetMs = targetMs;
    this.reserveMs = reserveMs;
    this.smoothing = smoothing;
    this.now = now;
    this.fixedMs = null;
    this.frameStart = 0;
    this.deferredMs = 0;
  }

  beginFrame() {
    this.frameStart = this.now();
    this.deferredMs = 0;
  }

  // Time this frame can still give deferred work: the target minus the usual
  // cost of everything else, clamped to [floorMs, maxMs].
  available(floorMs, maxMs) {
    const slack = this.fixedMs === null ? maxMs : this.targetMs - this.reserveMs - this.fixedMs - this.deferredMs;
    return Math.min(maxMs, Math.max(floorMs, slack));
  }

  // Runs deferred work and books its time, so it is not mistaken for the fixed
  // cost of the frame.
  defer(work) {
    const started = this.now();
    try {
      return work();
    } finally {
      this.deferredMs += this.now() - started;
    }
  }

  endFrame() {
    const fixed = Math.max(0, this.now() - this.frameStart - this.deferredMs);
    this.fixedMs = this.fixedMs === null ? fixed : this.fixedMs + (fixed - this.fixedMs) * this.smoothing;
    return this.fixedMs;
  }
}
