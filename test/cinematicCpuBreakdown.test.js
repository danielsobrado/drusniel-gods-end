import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountComposite,
  applyCpuMarks,
  resetCpuStats,
  wrapNodeUpdateBefore,
} from '../src/debug/cinematicCpuBreakdown.js';
import { GpuCreationProbe } from '../src/debug/gpuCreationHooks.js';

test('wrapped updateBefore accumulates into the named CPU bucket', () => {
  const stats = resetCpuStats({});
  const node = {
    calls: 0,
    updateBefore() { this.calls += 1; },
  };
  assert.equal(wrapNodeUpdateBefore(node, stats, 'scene'), true);
  node.updateBefore();
  node.updateBefore();
  assert.equal(node.calls, 2);
  assert.ok(stats.scene >= 0);
  assert.equal(wrapNodeUpdateBefore(node, stats, 'scene'), true);
});

test('composite is the remainder of the timed draw, not a sum of medians', () => {
  const stats = { scene: 4, depthResolve: 1, gtao: 2, bloom: 1.5 };
  accountComposite(stats, 10);
  assert.equal(stats.composite, 1.5);
  accountComposite(stats, 3);
  assert.equal(stats.composite, 0);
});

test('CPU marks are copied onto the profiler without replacing existing keys', () => {
  const profiler = { marks: { render: 12 } };
  applyCpuMarks(profiler, { scene: 8, gtao: 2 });
  assert.equal(profiler.marks.render, 12);
  assert.equal(profiler.marks.scene, 8);
  assert.equal(profiler.marks.gtao, 2);
});

test('creation probe times program and pipeline wrappers and restores them', () => {
  const backend = {
    createProgram() { const until = performance.now() + 1; while (performance.now() < until) { /* spin */ } },
    createRenderPipeline() {},
  };
  const originalProgram = backend.createProgram;
  const probe = new GpuCreationProbe({ backend });
  probe.beginFrame();
  backend.createProgram();
  backend.createRenderPipeline();
  assert.equal(probe.stats.programs, 1);
  assert.equal(probe.stats.pipelines, 1);
  assert.ok(probe.stats.programMs > 0);
  probe.dispose();
  assert.equal(backend.createProgram, originalProgram);
});
