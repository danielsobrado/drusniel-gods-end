import test from 'node:test';
import assert from 'node:assert/strict';
import { isWebGPUInfrastructureFailure, probeWebGPU } from '../scripts/browser/gpu-support.mjs';

test('WebGPU preflight enters the secure application origin before querying an adapter', async () => {
  let location = 'about:blank';
  const page = {
    goto: async (url, options) => {
      assert.equal(options.timeout, 2500);
      location = url;
    },
    evaluate: async (_callback, timeout) => {
      assert.equal(new URL(location).origin, 'http://127.0.0.1:5173');
      assert.equal(timeout, 2500);
      return { api: true, adapter: true, device: true };
    },
  };
  assert.deepEqual(await probeWebGPU(page, 'http://127.0.0.1:5173', 2500), {
    api: true, adapter: true, device: true,
  });
});

test('WebGPU preflight does not classify navigation/probe errors as unsupported hardware', async () => {
  await assert.rejects(probeWebGPU({
    goto: async () => { throw new Error('server unavailable'); },
  }, 'http://127.0.0.1:5173', 2500), /server unavailable/);
  await assert.rejects(probeWebGPU({
    goto: async () => {},
    evaluate: async () => { throw new Error('adapter probe timed out'); },
  }, 'http://127.0.0.1:5173', 2500), /adapter probe timed out/);
});


test('WebGPU infrastructure classification is narrow', () => {
  assert.equal(isWebGPUInfrastructureFailure(
    'THREE.WebGPURenderer: WebGPU Device Lost: A valid external Instance reference no longer exists.',
  ), true);
  assert.equal(isWebGPUInfrastructureFailure('Failed to create Vulkan device'), true);
  assert.equal(isWebGPUInfrastructureFailure('WGSL shader validation failed'), false);
  assert.equal(isWebGPUInfrastructureFailure('water rendered effectively black'), false);
});
