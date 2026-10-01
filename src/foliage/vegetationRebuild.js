export const VEGETATION_CPU_BUDGET_MS = 2;
export const VEGETATION_PREPARE_CONCURRENCY = 1;
export const VEGETATION_STARVE_TICKS = 8;

export class VegetationSampleCache {
  constructor() {
    this.cells = new Map();
    this.minX = 0;
    this.maxX = 0;
    this.minZ = 0;
    this.maxZ = 0;
    this.cellSize = 12;
  }

  setWindow(cellX, cellZ, extent, cellSize) {
    this.cellSize = cellSize;
    const pad = extent + 1;
    this.minX = cellX - pad;
    this.maxX = cellX + pad;
    this.minZ = cellZ - pad;
    this.maxZ = cellZ + pad;
    for (const key of [...this.cells.keys()]) {
      const split = key.indexOf(',');
      const x = Number(key.slice(0, split));
      const z = Number(key.slice(split + 1));
      if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) this.cells.delete(key);
    }
  }

  getOrCompute(x, z, compute) {
    const cellX = Math.floor(x / this.cellSize);
    const cellZ = Math.floor(z / this.cellSize);
    const cellKey = `${cellX},${cellZ}`;
    let cell = this.cells.get(cellKey);
    if (!cell) {
      cell = new Map();
      this.cells.set(cellKey, cell);
    }
    const pointKey = `${x},${z}`;
    let sample = cell.get(pointKey);
    if (!sample) {
      sample = compute(x, z);
      cell.set(pointKey, sample);
    }
    return sample;
  }

  clear() {
    this.cells.clear();
  }
}

export class VegetationJob {
  constructor({
    generate, consume, finalize, publish, reset, prepare,
    class: jobClass = 'placement', priority = 0, generation = 0, owner = null,
    estimateMs = 0, bounds = null, visibleRange = 0, onSettled,
  } = {}) {
    this.generate = generate;
    this.consume = consume;
    this.finalize = finalize;
    this.publish = publish;
    this.reset = reset;
    this.prepare = prepare;
    this.onSettled = onSettled;
    this.settled = false;
    this.class = jobClass;
    this.priority = priority;
    this.generation = generation;
    this.owner = owner;
    this.estimateMs = estimateMs;
    this.bounds = bounds;
    this.visibleRange = visibleRange;
    this.iterator = null;
    this.cancelled = false;
    this.done = false;
    this.failed = false;
    this.error = null;
    this.published = false;
    this.started = false;
    this.phase = 'generate';
    this.lifecycle = 'requested';
    this.lastStepMs = 0;
    this.overrunMs = 0;
    this.waitTicks = 0;
    this.preparePromise = null;
    this.abort = new AbortController();
  }

  cancel() {
    if (this.done) return;
    this.cancelled = true;
    this.done = true;
    this.lifecycle = 'cancelled';
    try { this.abort.abort(); } catch { /* already aborted */ }
    this.settle();
  }

  fail(error) {
    if (this.done) return;
    this.failed = true;
    this.error = error;
    this.done = true;
    this.lifecycle = 'failed';
    this.settle();
  }

  settle() {
    if (this.settled) return;
    this.settled = true;
    try { this.onSettled?.(this); } catch (error) { console.error('Vegetation job cleanup failed.', error); }
  }

  markPrepared() {
    if (this.cancelled || this.done || this.failed) return;
    this.lifecycle = 'prepared';
    // Completion callbacks only make the job runnable. Even calling a finalize
    // factory can do CPU work, so invoke it later from step(), inside the budget.
    this.phase = 'publish';
    this.iterator = { next: () => ({ done: true }) };
  }

  step(deadline, now = () => performance.now()) {
    const started = now();
    if (this.cancelled || this.done) {
      this.lastStepMs = 0;
      return;
    }
    if (this.phase === 'prepare') {
      this.lastStepMs = now() - started;
      return;
    }
    if (!this.started) {
      this.reset?.();
      this.iterator = this.generate();
      this.started = true;
      this.lifecycle = 'assets';
    }
    while (!this.cancelled && now() < deadline) {
      const next = this.iterator.next();
      if (next.done) {
        if (this.phase === 'generate' && this.prepare) {
          this.phase = 'prepare';
          this.lifecycle = 'staged';
          this.lastStepMs = now() - started;
          return;
        }
        if ((this.phase === 'generate' || this.phase === 'publish') && this.finalize && this.phase !== 'finalize') {
          if (now() >= deadline) {
            this.phase = 'publish';
            this.iterator = { next: () => ({ done: true }) };
            break;
          }
          this.phase = 'finalize';
          this.lifecycle = 'buffers';
          this.iterator = this.finalize();
          continue;
        }
        if (now() >= deadline) {
          this.phase = 'commit';
          this.iterator = { next: () => ({ done: true }) };
          break;
        }
        if (!this.cancelled) {
          this.publish?.();
          this.published = true;
          this.lifecycle = 'active';
        }
        this.done = true;
        this.settle();
        this.lastStepMs = now() - started;
        return;
      }
      if (next.value !== undefined) this.consume?.(next.value);
    }
    this.lastStepMs = now() - started;
  }
}

export async function collectCooperative(iterator, {
  signal,
  budgetMs = VEGETATION_CPU_BUDGET_MS,
  now = () => performance.now(),
} = {}) {
  const values = [];
  let deadline = now() + budgetMs;
  let step = iterator.next();
  while (!step.done) {
    signal?.throwIfAborted();
    if (step.value !== undefined) values.push(step.value);
    if (now() >= deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      deadline = now() + budgetMs;
    }
    step = iterator.next();
  }
  return values;
}

function emptyStats() {
  return {
    pending: 0,
    ageMax: 0,
    overruns: 0,
    worstStepMs: 0,
    cancellations: 0,
    failures: 0,
    prepares: 0,
    published: 0,
    inFlightPrepare: 0,
    frameCpuMs: 0,
  };
}

function visibilityPriority(job, context) {
  if (!context?.position || !job.bounds?.distanceToPoint) return job.priority;
  const distance = job.bounds.distanceToPoint(context.position);
  const remaining = distance - (job.visibleRange ?? 0);
  const speed = Number(context.speed) || 0;
  const eta = remaining <= 0 ? 0 : speed > 0.01 ? remaining / speed : remaining;
  return job.priority + eta;
}

export function createVegetationJobScheduler({
  budgetMs = VEGETATION_CPU_BUDGET_MS,
  now = () => performance.now(),
  prepareConcurrency = VEGETATION_PREPARE_CONCURRENCY,
} = {}) {
  const jobs = new Map();
  const order = [];
  const stats = emptyStats();
  let lastClass = null;
  let disposed = false;
  function startPrepare(job) {
    if (job.phase !== 'prepare' || job.preparePromise || job.cancelled || job.done) return false;
    if (stats.inFlightPrepare >= prepareConcurrency) return false;
    stats.inFlightPrepare += 1;
    stats.prepares += 1;
    const generation = job.generation;
    job.lifecycle = 'preparing';
    const finish = (error) => {
      stats.inFlightPrepare = Math.max(0, stats.inFlightPrepare - 1);
      job.preparePromise = null;
      if (error) {
        if (!job.cancelled) {
          job.fail(error);
          stats.failures += 1;
        }
        return;
      }
      if (job.cancelled || job.generation !== generation) return;
      try { job.markPrepared(); } catch (error) { job.fail(error); stats.failures += 1; }
    };
    // Invoke prepare on this tick so the compile render debits the CPU budget.
    // The returned promise is only the GPU wait; its then() must not publish.
    try {
      const result = job.prepare(job.abort.signal);
      if (result && typeof result.then === 'function') {
        job.preparePromise = result;
        result.then(() => finish(null), finish);
      } else {
        finish(null);
      }
    } catch (error) {
      finish(error);
    }
    return true;
  }
  return {
    budgetMs,
    now,
    prepareConcurrency,
    stats,
      replace(id, job) {
      if (disposed) { job.cancel(); return; }
      this.cancel(id);
      job.enqueuedAt = now();
      job.waitTicks = 0;
      jobs.set(id, job);
      order.push(id);
    },
    cancel(id) {
      const job = jobs.get(id);
      if (!job) return;
      const wasDone = job.done;
      job.cancel();
      jobs.delete(id);
      const index = order.indexOf(id);
      if (index >= 0) order.splice(index, 1);
      if (!wasDone) stats.cancellations += 1;
    },
    tick(context = {}) {
      const started = now();
      // The frame may hand over less than the default when it has less slack.
      const frameBudget = Number(context.budgetMs);
      const deadline = started + (Number.isFinite(frameBudget) && frameBudget >= 0 ? Math.min(frameBudget, budgetMs) : budgetMs);
      for (const job of jobs.values()) job.waitTicks += 1;
      const ranked = [...order].sort((a, b) => {
        const left = jobs.get(a);
        const right = jobs.get(b);
        const starveLeft = left.waitTicks >= VEGETATION_STARVE_TICKS;
        const starveRight = right.waitTicks >= VEGETATION_STARVE_TICKS;
        if (starveLeft !== starveRight) return starveLeft ? -1 : 1;
        if (starveLeft && starveRight) return right.waitTicks - left.waitTicks;
        const classTurn = lastClass && left.class === lastClass && right.class !== lastClass;
        const classTurnOther = lastClass && right.class === lastClass && left.class !== lastClass;
        if (classTurn !== classTurnOther) return classTurn ? 1 : -1;
        return visibilityPriority(left, context) - visibilityPriority(right, context);
      });
      for (const id of ranked) {
        if (now() >= deadline) break;
        const job = jobs.get(id);
        if (!job) continue;
        if (job.done) {
          if (job.published) stats.published += 1;
          if (jobs.get(id) !== job) continue;
          jobs.delete(id);
          const index = order.indexOf(id);
          if (index >= 0) order.splice(index, 1);
          continue;
        }
        if (job.phase === 'prepare' && job.preparePromise) continue;
        const remaining = deadline - now();
        if (job.phase === 'prepare') {
          const beforePrepare = now();
          if (!startPrepare(job)) continue;
          job.lastStepMs = now() - beforePrepare;
        } else {
          // An oversized non-preemptible step gets one turn after aging; do not
          // let it block smaller work forever due to ranking overhead.
          if (job.estimateMs > remaining && job.waitTicks < VEGETATION_STARVE_TICKS) continue;
          const beforeStep = now();
          try { job.step(deadline, now); } catch (error) {
            job.fail(error);
            stats.failures += 1;
          }
          job.lastStepMs = now() - beforeStep;
          const beforePrepare = now();
          if (beforePrepare < deadline) startPrepare(job);
          job.lastStepMs += now() - beforePrepare;
        }
        stats.worstStepMs = Math.max(stats.worstStepMs, job.lastStepMs);
        if (job.lastStepMs > remaining) {
          stats.overruns += 1;
          job.overrunMs += job.lastStepMs - Math.max(0, remaining);
        }
        lastClass = job.class;
        job.waitTicks = 0;
        if (job.done) {
          if (job.published) stats.published += 1;
          if (jobs.get(id) !== job) continue;
          jobs.delete(id);
          const index = order.indexOf(id);
          if (index >= 0) order.splice(index, 1);
        }
      }
      stats.pending = jobs.size;
      stats.frameCpuMs = now() - started;
      stats.ageMax = 0;
      stats.inFlightPrepare = Math.min(stats.inFlightPrepare, prepareConcurrency);
      for (const job of jobs.values()) stats.ageMax = Math.max(stats.ageMax, job.waitTicks);
    },
    pending(id) {
      return jobs.has(id);
    },
    get(id) {
      return jobs.get(id) ?? null;
    },
    dispose() {
      disposed = true;
      for (const id of [...jobs.keys()]) this.cancel(id);
    },
  };
}
