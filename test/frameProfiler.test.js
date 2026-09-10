import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameProfiler, gpuTimestampSample, hitchCreationBreakdown, isProfileRequested } from '../src/debug/FrameProfiler.js';

test('profile query is opt-in', () => {
  assert.equal(isProfileRequested(''), false);
  assert.equal(isProfileRequested('?renderer=webgl'), false);
  assert.equal(isProfileRequested('?profile=1'), true);
  assert.equal(isProfileRequested('?profile=0'), false);
});

test('timed capture records processing separately from frame interval', async () => {
  const profiler = new FrameProfiler();
  profiler.startTimed({ warmupSeconds: 0, measureSeconds: 0.05 });
  const started = performance.now();
  while (performance.now() - started < 80) {
    profiler.beginFrame();
    profiler.time('grass', () => {
      const until = performance.now() + 1;
      while (performance.now() < until) { /* spin */ }
    });
    await new Promise((resolve) => setTimeout(resolve, 8));
    profiler.endFrame({ drawCalls: 10, triangles: 100, reflectionCaptures: 0, compactionMs: 0.2 });
  }
  const summary = profiler.summarize();
  assert.ok(summary.frames > 0);
  assert.ok(summary.processing.median > 0);
  assert.ok(summary.interval.median >= summary.processing.median);
  assert.ok(summary.subsystems.grass.median > 0);
  assert.equal(summary.drawCalls.median, 10);
});

test('unavailable GPU timestamps are null rather than zero', () => {
  assert.equal(gpuTimestampSample(0), null);
  assert.equal(gpuTimestampSample(undefined), null);
  assert.equal(gpuTimestampSample(NaN), null);
  assert.equal(gpuTimestampSample(1.25), 1.25);
  const profiler = new FrameProfiler();
  profiler.startTimed({ warmupSeconds: 0, measureSeconds: 1 });
  profiler.beginFrame();
  profiler.endFrame({ gpuTimestamp: 0, drawCalls: 4 });
  profiler.beginFrame();
  profiler.endFrame({ gpuTimestamp: 2.5, drawCalls: 4 });
  const summary = profiler.summarize();
  assert.equal(summary.gpuTimestamp.median, 2.5);
  assert.equal(summary.gpuTimestamp.count, 1);
});

test('a hitch that overruns the measure window still records a sample so the run can finish', async () => {
  const profiler = new FrameProfiler();
  profiler.startTimed({ warmupSeconds: 0.01, measureSeconds: 0.01 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  profiler.beginFrame();
  profiler.endFrame({ drawCalls: 3 });
  const summary = profiler.summarize();
  assert.equal(profiler.done, true);
  assert.equal(summary.frames, 1);
  assert.equal(summary.drawCalls.median, 3);
  assert.equal(summary.hitch.maxProcessingMs, summary.processing.max);
});

test('hitch summary keeps the first recorded frame and counts long processing spikes', () => {
  const profiler = new FrameProfiler();
  profiler.startTimed({ warmupSeconds: 0, measureSeconds: 1 });
  profiler.beginFrame();
  profiler.time('gpuProgram', () => {});
  profiler.marks.gpuProgram = 1200;
  profiler.endFrame({ drawCalls: 1, gpuPrograms: 8, gpuPipelines: 3 });
  profiler.samples[0].processingMs = 12;
  profiler.samples.push({
    processingMs: 4336,
    intervalMs: 4336,
    vsyncLimited: false,
    marks: {},
    drawCalls: 1,
    triangles: 1,
    gpuTimestamp: null,
    reflectionCaptures: 0,
    compactionMs: 4,
    occlusionMs: 0,
    gpuPrograms: 0,
    gpuPipelines: 0,
  });
  const hitch = profiler.summarize().hitch;
  assert.equal(hitch.firstProcessingMs, 12);
  assert.equal(hitch.maxProcessingMs, 4336);
  assert.equal(hitch.framesOver100ms, 1);
  assert.equal(hitch.framesOver50ms, 1);
  assert.equal(hitch.firstGpuPrograms, 8);
  assert.equal(hitch.firstGpuPipelines, 3);
  assert.equal(hitch.firstMarks.gpuProgram, 1200);
});

test('hitch creation pairs duration with counts; remaining time stays outside those marks', () => {
  const breakdown = hitchCreationBreakdown({
    processingMs: 4275,
    gpuPrograms: 12,
    gpuPipelines: 40,
    marks: {
      render: 4214,
      gpuProgram: 180,
      gpuPipeline: 90,
      scene: 4000,
    },
  });
  assert.equal(breakdown.inclusive, true);
  assert.equal(breakdown.gpuProgram.ms, 180);
  assert.equal(breakdown.gpuProgram.count, 12);
  assert.equal(breakdown.gpuPipeline.ms, 90);
  assert.equal(breakdown.gpuPipeline.count, 40);
  assert.equal(breakdown.creationMs, 270);
  assert.equal(breakdown.outsideCreationMs, 3944);
  assert.equal(breakdown.outsideCreationProcessingMs, 4005);
});
