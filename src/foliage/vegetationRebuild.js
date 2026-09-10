export const VEGETATION_CPU_BUDGET_MS = 2;

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
  constructor({ generate, consume, finalize, publish, reset } = {}) {
    this.generate = generate;
    this.consume = consume;
    this.finalize = finalize;
    this.publish = publish;
    this.reset = reset;
    this.iterator = null;
    this.cancelled = false;
    this.done = false;
    this.published = false;
    this.started = false;
    this.phase = 'generate';
  }

  cancel() {
    this.cancelled = true;
    this.done = true;
  }

  step(deadline, now = () => performance.now()) {
    if (this.cancelled || this.done) return;
    if (!this.started) {
      this.reset?.();
      this.iterator = this.generate();
      this.started = true;
    }
    while (!this.cancelled && now() < deadline) {
      const next = this.iterator.next();
      if (next.done) {
        if (this.phase === 'generate' && this.finalize) {
          this.phase = 'finalize';
          this.iterator = this.finalize();
          continue;
        }
        if (!this.cancelled) {
          this.publish?.();
          this.published = true;
        }
        this.done = true;
        return;
      }
      if (next.value !== undefined) this.consume?.(next.value);
    }
  }
}

export function createVegetationJobScheduler({
  budgetMs = VEGETATION_CPU_BUDGET_MS,
  now = () => performance.now(),
} = {}) {
  const jobs = new Map();
  const order = [];
  return {
    budgetMs,
    now,
    replace(id, job) {
      this.cancel(id);
      jobs.set(id, job);
      order.push(id);
    },
    cancel(id) {
      const job = jobs.get(id);
      if (!job) return;
      job.cancel();
      jobs.delete(id);
      const index = order.indexOf(id);
      if (index >= 0) order.splice(index, 1);
    },
    tick() {
      const deadline = now() + budgetMs;
      for (const id of [...order]) {
        if (now() >= deadline) break;
        const job = jobs.get(id);
        if (!job) continue;
        job.step(deadline, now);
        if (job.done) {
          jobs.delete(id);
          const index = order.indexOf(id);
          if (index >= 0) order.splice(index, 1);
        }
      }
    },
    pending(id) {
      return jobs.has(id);
    },
    dispose() {
      for (const id of [...jobs.keys()]) this.cancel(id);
    },
  };
}
