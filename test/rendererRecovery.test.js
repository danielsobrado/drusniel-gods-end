import assert from 'node:assert/strict';
import test from 'node:test';
import { RendererRecovery } from '../src/rendering/RendererRecovery.js';

test('auto retries WebGPU then WebGL with the same logical state, never loops', async () => {
  const state = { mask: new Uint8Array([1, 2]) }; const attempts = []; const failures = [];
  const recovery = new RendererRecovery({ capture: () => state, release() {},
    restart: async (backend, saved) => { assert.equal(saved, state); attempts.push(backend); if (backend === 'webgpu') throw Error('lost'); },
    onFailure: (error) => failures.push(error) });
  await recovery.recover('auto', 'webgpu', {});
  assert.deepEqual(attempts, ['webgpu', 'webgl']);
  await recovery.recover('auto', 'webgl2', {});
  assert.equal(attempts.length, 2);
  assert.match(failures[0].message, /budget/);
});

test('forced WebGPU never silently changes backend', async () => {
  const attempts = []; let failed = false;
  const recovery = new RendererRecovery({ capture() {}, release() {},
    restart: async (backend) => { attempts.push(backend); throw Error('unavailable'); },
    onFailure: () => { failed = true; } });
  await recovery.recover('webgpu', 'webgpu', {});
  assert.deepEqual(attempts, ['webgpu']); assert.equal(failed, true);
});

test('concurrent loss signals share one restart and disposal releases late session', async () => {
  let complete; let releases = 0; let starts = 0;
  const recovery = new RendererRecovery({ capture() {}, release: () => releases++,
    restart: () => { starts++; return new Promise((resolve) => { complete = resolve; }); },
    onFailure: () => assert.fail('disposed recovery must not show errors') });
  const first = recovery.recover('auto', 'webgpu', {});
  assert.equal(recovery.recover('auto', 'webgpu', {}), first);
  recovery.dispose(); complete(); await first;
  assert.equal(starts, 1); assert.equal(releases, 2);
});

test('an exhausted backend list releases once per attempt and still presents the failure', async () => {
  // Forced WebGPU is one backend and one attempt, which makes the release count
  // exact: one for the renderer being replaced, one for the failed attempt.
  // A third — thrown into the shared catch on the way out — is the defect. It
  // is not merely redundant: a release that throws there replaces the recovery
  // failure the owner has to present with the cleanup error instead.
  let releases = 0; const failures = [];
  const recovery = new RendererRecovery({
    capture() {},
    release: () => { releases++; },
    restart: async () => { throw Error('unavailable'); },
    onFailure: (error) => failures.push(error),
  });
  await recovery.recover('webgpu', 'webgpu', {});
  assert.equal(releases, 2);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /Renderer recovery failed/);
});

test('cleanup failure retains the restart failure and is released only once', async () => {
  let releases = 0;
  const failures = [];
  const recovery = new RendererRecovery({ capture: () => ({}),
    release() { if (++releases > 1) throw new Error('cleanup fault'); },
    async restart() { throw new Error('shader fault'); },
    onFailure: error => failures.push(error) });
  await recovery.recover('webgpu', 'webgpu', {});
  assert.equal(releases, 2);
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].errors.map(error => error.message), ['shader fault', 'cleanup fault']);
});

test('reentrant loss during capture coalesces with the already published recovery', async () => {
  let nested;
  let entered = false;
  let starts = 0;
  const recovery = new RendererRecovery({ capture() {
    if (!entered) { entered = true; nested = recovery.recover('auto', 'webgpu', {}); }
    return {};
  }, release() {}, async restart() { starts++; }, onFailure: error => { throw error; } });
  const pending = recovery.recover('auto', 'webgpu', {});
  await pending;
  assert.equal(nested, pending);
  assert.equal(starts, 1);
});
