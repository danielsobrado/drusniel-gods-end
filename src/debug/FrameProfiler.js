function sorted(values) {
  return values.slice().sort((a, b) => a - b);
}

function atPercentile(values, percentile) {
  if (!values.length) return 0;
  const rank = Math.min(values.length - 1, Math.max(0, Math.ceil((percentile / 100) * values.length) - 1));
  return values[rank];
}

function summarizeValues(values) {
  const data = sorted(values);
  const sum = data.reduce((total, value) => total + value, 0);
  return {
    count: data.length,
    mean: data.length ? sum / data.length : 0,
    median: atPercentile(data, 50),
    p95: atPercentile(data, 95),
    p99: atPercentile(data, 99),
    min: data[0] ?? 0,
    max: data[data.length - 1] ?? 0,
  };
}

function displayRefreshMs() {
  const rate = Number(globalThis.screen?.orientation ? globalThis.screen?.refreshRate : 0)
    || Number(globalThis.screen?.refreshRate)
    || 0;
  return rate > 0 ? 1000 / rate : 1000 / 60;
}

export function gpuTimestampSample(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Pair first-frame creation duration with counts. Nested marks stay inclusive. */
export function hitchCreationBreakdown(sample) {
  const marks = sample?.marks ?? {};
  const processingMs = sample?.processingMs ?? 0;
  const renderMs = marks.render ?? 0;
  const nodeBuildMs = marks.gpuNodeBuild ?? 0;
  const programMs = marks.gpuProgram ?? 0;
  const pipelineMs = marks.gpuPipeline ?? 0;
  const creationMs = nodeBuildMs + programMs + pipelineMs;
  return {
    inclusive: true,
    processingMs,
    renderMs,
    gpuNodeBuild: { ms: nodeBuildMs, count: sample?.gpuNodeBuilds ?? 0 },
    gpuProgram: { ms: programMs, count: sample?.gpuPrograms ?? 0 },
    gpuPipeline: { ms: pipelineMs, count: sample?.gpuPipelines ?? 0 },
    creationMs,
    outsideCreationMs: Math.max(0, renderMs - creationMs),
    outsideCreationProcessingMs: Math.max(0, processingMs - creationMs),
  };
}

export function firstFrameBreakdown(sample) {
  const processingMs = sample?.processingMs ?? 0;
  const marks = sample?.marks ?? {};
  const renderMs = marks.render ?? 0;
  const outsideRenderMs = Math.max(0, processingMs - renderMs);
  const ranked = Object.entries(marks)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, ms]) => ({ name, ms }));
  return {
    processingMs,
    renderMs,
    outsideRenderMs,
    reflectionsMs: (marks.planarReflections ?? 0) + (marks.cubeReflections ?? 0),
    gpuUploadMs: (marks.gpuAttribute ?? 0) + (marks.gpuTexture ?? 0),
    occlusionPrepareMs: marks.occlusionPrepare ?? marks.occlusionMs ?? 0,
    postRenderMs: marks.postRender ?? 0,
    sceneMs: marks.scene ?? 0,
    depthResolveMs: marks.depthResolve ?? 0,
    gtaoMs: marks.gtao ?? 0,
    bloomMs: marks.bloom ?? 0,
    compositeMs: marks.composite ?? 0,
    ranked,
  };
}

/** Opt-in frame cost recorder. Distinguishes vsync-limited intervals from processing work. */
export class FrameProfiler {
  constructor() {
    this.enabled = true;
    this.recording = false;
    this.warming = false;
    this.samples = [];
    this.marks = Object.create(null);
    this.frameStart = 0;
    this.lastEnd = 0;
    this.warmupUntil = 0;
    this.measureUntil = 0;
    this.lastCaptures = 0;
    this.frameLimit = 0;
    this.captureLabel = null;
    this.captures = Object.create(null);
  }

  beginFrame() {
    this.frameStart = performance.now();
    this.marks = Object.create(null);
  }

  time(name, fn) {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.marks[name] = (this.marks[name] ?? 0) + (performance.now() - start);
    }
  }

  startTimed({ warmupSeconds = 5, measureSeconds = 30 } = {}) {
    const now = performance.now();
    this.samples = [];
    this.warmupUntil = now + warmupSeconds * 1000;
    this.measureUntil = this.warmupUntil + measureSeconds * 1000;
    this.recording = true;
    this.warming = true;
    this.lastEnd = 0;
    this.lastCaptures = 0;
    this.frameLimit = 0;
    this.captureLabel = null;
  }

  startFrames({ frames = 8, label = 'startup' } = {}) {
    this.samples = [];
    this.warmupUntil = 0;
    this.measureUntil = Number.POSITIVE_INFINITY;
    this.recording = true;
    this.warming = false;
    this.lastEnd = 0;
    this.lastCaptures = 0;
    this.frameLimit = Math.max(1, Math.floor(Number(frames) || 1));
    this.captureLabel = label || null;
  }

  get done() {
    return !this.recording && this.samples.length > 0;
  }

  endFrame(snapshot = {}) {
    const now = performance.now();
    const processingMs = now - this.frameStart;
    const intervalMs = this.lastEnd ? now - this.lastEnd : processingMs;
    this.lastEnd = now;
    if (!this.recording) return;
    if (now < this.warmupUntil) return;
    this.warming = false;
    const windowClosed = now >= this.measureUntil;
    if (windowClosed && this.samples.length > 0) {
      this.recording = false;
      return;
    }
    const refreshMs = displayRefreshMs();
    const vsyncLimited = processingMs * 1.35 < intervalMs && intervalMs > refreshMs * 0.85;
    this.samples.push({
      processingMs,
      intervalMs,
      vsyncLimited,
      marks: this.marks,
      drawCalls: snapshot.drawCalls ?? 0,
      triangles: snapshot.triangles ?? 0,
      gpuTimestamp: gpuTimestampSample(snapshot.gpuTimestamp),
      reflectionCaptures: snapshot.reflectionCaptures ?? 0,
      compactionMs: snapshot.compactionMs ?? 0,
      occlusionMs: snapshot.occlusionMs ?? 0,
      gpuPrograms: snapshot.gpuPrograms ?? 0,
      gpuPipelines: snapshot.gpuPipelines ?? 0,
      gpuAttributes: snapshot.gpuAttributes ?? 0,
      gpuTextures: snapshot.gpuTextures ?? 0,
      gpuNodeBuilds: snapshot.gpuNodeBuilds ?? 0,
      colliders: snapshot.colliders ?? 0,
      biomeNear: snapshot.biomeNear ?? 0,
      biomeMid: snapshot.biomeMid ?? 0,
      biomeFar: snapshot.biomeFar ?? 0,
      biomeBookkeepingMs: snapshot.biomeBookkeepingMs ?? 0,
      biomeTriangles: snapshot.biomeTriangles ?? 0,
    });
    const frameLimitReached = this.frameLimit > 0 && this.samples.length >= this.frameLimit;
    if (windowClosed || frameLimitReached) {
      this.recording = false;
      if (this.captureLabel) this.captures[this.captureLabel] = this.summarize();
    }
  }

  summarize() {
    const processing = summarizeValues(this.samples.map((sample) => sample.processingMs));
    const interval = summarizeValues(this.samples.map((sample) => sample.intervalMs));
    const names = new Set(this.samples.flatMap((sample) => Object.keys(sample.marks)));
    const subsystems = {};
    for (const name of names) {
      subsystems[name] = summarizeValues(this.samples.map((sample) => sample.marks[name] ?? 0));
    }
    const gpuValues = this.samples.map((sample) => sample.gpuTimestamp).filter((value) => Number.isFinite(value) && value > 0);
    return {
      frames: this.samples.length,
      processing,
      interval,
      vsyncLimitedShare: this.samples.length
        ? this.samples.filter((sample) => sample.vsyncLimited).length / this.samples.length
        : 0,
      refreshMs: displayRefreshMs(),
      subsystems,
      drawCalls: summarizeValues(this.samples.map((sample) => sample.drawCalls)),
      triangles: summarizeValues(this.samples.map((sample) => sample.triangles)),
      reflectionCaptures: this.samples.reduce((total, sample) => total + sample.reflectionCaptures, 0),
      compactionMs: summarizeValues(this.samples.map((sample) => sample.compactionMs)),
      gpuTimestamp: gpuValues.length ? summarizeValues(gpuValues) : null,
      colliders: summarizeValues(this.samples.map((sample) => sample.colliders ?? 0)),
      biome: {
        near: summarizeValues(this.samples.map((sample) => sample.biomeNear ?? 0)),
        mid: summarizeValues(this.samples.map((sample) => sample.biomeMid ?? 0)),
        far: summarizeValues(this.samples.map((sample) => sample.biomeFar ?? 0)),
        bookkeepingMs: summarizeValues(this.samples.map((sample) => sample.biomeBookkeepingMs ?? 0)),
        triangles: summarizeValues(this.samples.map((sample) => sample.biomeTriangles ?? 0)),
      },
      hitch: {
        firstProcessingMs: this.samples[0]?.processingMs ?? 0,
        firstIntervalMs: this.samples[0]?.intervalMs ?? 0,
        maxProcessingMs: processing.max ?? 0,
        maxIntervalMs: interval.max ?? 0,
        framesOver50ms: this.samples.filter((sample) => sample.processingMs >= 50).length,
        framesOver100ms: this.samples.filter((sample) => sample.processingMs >= 100).length,
        firstMarks: this.samples[0]?.marks ?? null,
        firstGpuPrograms: this.samples[0]?.gpuPrograms ?? 0,
        firstGpuPipelines: this.samples[0]?.gpuPipelines ?? 0,
        firstGpuAttributes: this.samples[0]?.gpuAttributes ?? 0,
        firstGpuTextures: this.samples[0]?.gpuTextures ?? 0,
        firstGpuNodeBuilds: this.samples[0]?.gpuNodeBuilds ?? 0,
        creation: hitchCreationBreakdown(this.samples[0]),
        firstFrame: firstFrameBreakdown(this.samples[0]),
      },
    };
  }
}

export function isProfileRequested(search = globalThis.location?.search ?? '') {
  return new URLSearchParams(search).get('profile') === '1';
}
