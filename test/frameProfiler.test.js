import assert from 'node:assert/strict';
import test from 'node:test';
import {
  firstFrameBreakdown,
  FrameProfiler,
  gpuTimestampSample,
  hitchCreationBreakdown,
  isProfileRequested,
} from '../src/debug/FrameProfiler.js';

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
    gpuNodeBuilds: 7,
    marks: {
      render: 4214,
      gpuNodeBuild: 45,
      gpuProgram: 180,
      gpuPipeline: 90,
      scene: 4000,
    },
  });
  assert.equal(breakdown.inclusive, true);
  assert.equal(breakdown.gpuNodeBuild.ms, 45);
  assert.equal(breakdown.gpuNodeBuild.count, 7);
  assert.equal(breakdown.gpuProgram.ms, 180);
  assert.equal(breakdown.gpuProgram.count, 12);
  assert.equal(breakdown.gpuPipeline.ms, 90);
  assert.equal(breakdown.gpuPipeline.count, 40);
  assert.equal(breakdown.creationMs, 315);
  assert.equal(breakdown.outsideCreationMs, 3899);
  assert.equal(breakdown.outsideCreationProcessingMs, 3960);
});


test('bounded startup capture records exactly the requested first frames', () => {
  const profiler = new FrameProfiler();
  profiler.startFrames({ frames: 3, label: 'startup' });
  for (let frame = 0; frame < 5; frame += 1) {
    profiler.beginFrame();
    profiler.marks.render = 10 + frame;
    profiler.endFrame({ drawCalls: frame + 1 });
  }
  assert.equal(profiler.recording, false);
  assert.equal(profiler.samples.length, 3);
  assert.equal(profiler.captures.startup.frames, 3);
  assert.equal(profiler.captures.startup.drawCalls.max, 3);
});

test('first-frame breakdown separates render work and ranks inclusive marks', () => {
  const breakdown = firstFrameBreakdown({
    processingMs: 100,
    marks: {
      render: 70,
      postRender: 60,
      scene: 45,
      planarReflections: 20,
      cubeReflections: 5,
      gpuAttribute: 7,
      gpuTexture: 3,
      occlusionPrepare: 4,
    },
  });
  assert.equal(breakdown.renderMs, 70);
  assert.equal(breakdown.outsideRenderMs, 30);
  assert.equal(breakdown.reflectionsMs, 25);
  assert.equal(breakdown.gpuUploadMs, 10);
  assert.equal(breakdown.occlusionPrepareMs, 4);
  assert.equal(breakdown.ranked[0].name, 'render');
});
