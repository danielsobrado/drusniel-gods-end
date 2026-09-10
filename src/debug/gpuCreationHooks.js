function emptyStats() {
  return { programMs: 0, pipelineMs: 0, programs: 0, pipelines: 0 };
}

function wrap(target, name, stats, kind) {
  if (!target || typeof target[name] !== 'function' || target[name].__cpuCreationHook) return null;
  const original = target[name];
  const hooked = function (...args) {
    const start = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      const elapsed = performance.now() - start;
      if (kind === 'program') {
        stats.programMs += elapsed;
        stats.programs += 1;
      } else {
        stats.pipelineMs += elapsed;
        stats.pipelines += 1;
      }
    }
  };
  hooked.__cpuCreationHook = true;
  target[name] = hooked;
  return () => {
    if (target[name] === hooked) target[name] = original;
  };
}

/** Times shader-module and pipeline creation on the active Three backend. */
export class GpuCreationProbe {
  constructor(renderer) {
    this.stats = emptyStats();
    this.restores = [];
    const backend = renderer?.backend;
    if (!backend) return;
    const bind = (target, name, kind) => {
      const restore = wrap(target, name, this.stats, kind);
      if (restore) this.restores.push(restore);
    };
    bind(backend, 'createProgram', 'program');
    bind(backend, 'createRenderPipeline', 'pipeline');
    bind(backend, 'createComputePipeline', 'pipeline');
    // Device createShaderModule / createRenderPipeline are called from the
    // backend methods above. Wrapping both would double-count durations.
  }

  beginFrame() {
    this.stats.programMs = 0;
    this.stats.pipelineMs = 0;
    this.stats.programs = 0;
    this.stats.pipelines = 0;
    return this.stats;
  }

  dispose() {
    for (const restore of this.restores) restore();
    this.restores.length = 0;
  }
}
