function emptyStats() {
  return {
    programMs: 0,
    pipelineMs: 0,
    attributeMs: 0,
    textureMs: 0,
    nodeBuildMs: 0,
    programs: 0,
    pipelines: 0,
    attributes: 0,
    textures: 0,
    nodeBuilds: 0,
  };
}

function wrap(target, name, stats, msKey, countKey) {
  if (!target || typeof target[name] !== 'function' || target[name].__cpuCreationHook) return null;
  const original = target[name];
  const hooked = function (...args) {
    const start = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      stats[msKey] += performance.now() - start;
      stats[countKey] += 1;
    }
  };
  hooked.__cpuCreationHook = true;
  target[name] = hooked;
  return () => {
    if (target[name] === hooked) target[name] = original;
  };
}

/** Times shader/pipeline creation and first-use GPU resource uploads on the active Three backend. */
export class GpuCreationProbe {
  constructor(renderer) {
    this.stats = emptyStats();
    this.restores = [];
    const debug = renderer?.debug;
    if (debug && 'onNodeBuilderCreated' in debug) {
      const previous = debug.onNodeBuilderCreated;
      const hooked = (builder, target) => {
        previous?.(builder, target);
        const original = builder?.build;
        if (typeof original !== 'function' || original.__cpuCreationHook) return;
        const build = function (...args) {
          const start = performance.now();
          try {
            return original.apply(this, args);
          } finally {
            thisProbe.stats.nodeBuildMs += performance.now() - start;
            thisProbe.stats.nodeBuilds += 1;
          }
        };
        build.__cpuCreationHook = true;
        builder.build = build;
      };
      const thisProbe = this;
      debug.onNodeBuilderCreated = hooked;
      this.restores.push(() => {
        if (debug.onNodeBuilderCreated === hooked) debug.onNodeBuilderCreated = previous;
      });
    }

    const backend = renderer?.backend;
    if (!backend) return;
    const bind = (target, name, msKey, countKey) => {
      const restore = wrap(target, name, this.stats, msKey, countKey);
      if (restore) this.restores.push(restore);
    };
    bind(backend, 'createProgram', 'programMs', 'programs');
    bind(backend, 'createRenderPipeline', 'pipelineMs', 'pipelines');
    bind(backend, 'createComputePipeline', 'pipelineMs', 'pipelines');
    bind(backend, 'createAttribute', 'attributeMs', 'attributes');
    bind(backend, 'updateAttribute', 'attributeMs', 'attributes');
    bind(backend, 'createIndexAttribute', 'attributeMs', 'attributes');
    bind(backend, 'createStorageAttribute', 'attributeMs', 'attributes');
    bind(backend, 'createIndirectStorageAttribute', 'attributeMs', 'attributes');
    bind(backend, 'createTexture', 'textureMs', 'textures');
    bind(backend, 'updateTexture', 'textureMs', 'textures');
  }

  beginFrame() {
    Object.assign(this.stats, emptyStats());
    return this.stats;
  }

  dispose() {
    for (const restore of this.restores) restore();
    this.restores.length = 0;
  }
}
