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

test('a second WebGPU loss uses the remaining recovery attempt for WebGL', async () => {
  const attempts = [];
  const recovery = new RendererRecovery({ capture: () => ({}), release() {},
    restart: async backend => { attempts.push(backend); },
    onFailure: error => assert.fail(error.message) });
  await recovery.recover('auto', 'webgpu', {});
  await recovery.recover('auto', 'webgpu', {});
  assert.deepEqual(attempts, ['webgpu', 'webgl']);
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
