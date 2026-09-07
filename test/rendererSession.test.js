import assert from 'node:assert/strict';
import test from 'node:test';
import { createRendererSession, resolveRendererRequest } from '../src/rendering/RendererSession.js';
import { readRendererCapabilities } from '../src/rendering/RendererCapabilities.js';
import { ResourceScope } from '../src/utils/ResourceScope.js';

function fixture(actual = 'webgpu', init = async () => {}) {
  const calls = [];
  const renderer = {
    init, dispose() { calls.push('dispose'); },
    setAnimationLoop(value) { calls.push(['loop', value]); },
    domElement: { remove() { calls.push('remove'); } },
    onDeviceLost() { calls.push('original-loss'); },
  };
  return { renderer, calls, createRenderer(options) { calls.push(options); return renderer; },
    readCapabilities: () => ({ backend: actual }) };
}

test('valid explicit selection overrides config; invalid selection reports and retains config', () => {
  const warnings = [];
  assert.equal(resolveRendererRequest('?renderer=auto', true), 'auto');
  assert.equal(resolveRendererRequest('?renderer=webgl', false), 'webgl');
  assert.equal(resolveRendererRequest('', true), 'webgl');
  assert.equal(resolveRendererRequest('?renderer=bad', true, (x) => warnings.push(x)), 'webgl');
  assert.equal(warnings.length, 1);
});

test('auto reports actual fallback, forced WebGPU rejects it and rolls back', async () => {
  const f = fixture('webgl2');
  const session = await createRendererSession(f);
  assert.equal(session.diagnostics.actual, 'webgl2');
  assert.match(session.diagnostics.fallbackReason, /WebGPU/);
  session.dispose(); session.dispose();
  assert.equal(f.calls.filter((x) => x === 'dispose').length, 1);
  const forced = fixture('webgl2');
  await assert.rejects(createRendererSession({ ...forced, request: 'webgpu' }), /explicitly requested/);
  assert.equal(forced.calls.filter((x) => x === 'dispose').length, 1);
});

test('forceWebGL option cannot be overwritten by caller options', async () => {
  const f = fixture('webgl2');
  const session = await createRendererSession({ ...f, request: 'webgl', options: { forceWebGL: false } });
  assert.equal(f.calls[0].forceWebGL, true);
  session.dispose();
});

test('failed init preserves original error and releases candidate', async () => {
  const error = new Error('adapter failed');
  const f = fixture('webgpu', async () => { throw error; });
  await assert.rejects(createRendererSession(f), (value) => value === error);
  assert.ok(f.calls.includes('remove'));
});

test('cancellation during init releases late renderer without publishing session', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const controller = new AbortController();
  const f = fixture('webgpu', () => pending);
  const result = createRendererSession({ ...f, signal: controller.signal });
  controller.abort(); resolve();
  await assert.rejects(result, { name: 'AbortError' });
  assert.ok(f.calls.includes('dispose'));
});

test('device loss forwards original callback, subscriptions release on dispose', async () => {
  const f = fixture(); const s = await createRendererSession(f);
  const messages = [];
  const off = s.subscribeDeviceLoss((x) => messages.push(x));
  f.renderer.onDeviceLost('one'); off(); f.renderer.onDeviceLost('two');
  assert.deepEqual(messages, ['one']);
  assert.equal(f.calls.filter((x) => x === 'original-loss').length, 2);
  s.dispose();
});

test('WebGL capability adapter never advertises native compute', () => {
  const gl = { MAX_TEXTURE_SIZE: 1, MAX_SAMPLES: 2, getParameter: (key) => key === 1 ? 4096 : 4,
    getExtension: () => null };
  const caps = readRendererCapabilities({ backend: { isWebGLBackend: true, gl } });
  assert.equal(caps.nativeCompute, false); assert.equal(caps.indirectDraw, false);
  assert.equal(caps.gpuTiming, false); assert.equal(caps.maxTextureSize, 4096);
  assert.equal(caps.colorTargetHalfFloat, false);
  assert.throws(() => readRendererCapabilities({ backend: {} }), /unrecognized/);
});

test('a half-float-only device still reports a renderable half-float target', () => {
  // Either extension makes a half-float colour target renderable, and a device
  // may expose only the half-float one. Probing the float extension alone
  // reports no renderable half-float target there, so any pass that picks its
  // precision from this drops to bytes for no reason.
  const probed = [];
  const gl = { getParameter: () => 4096,
    getExtension: (name) => { probed.push(name); return name === 'EXT_color_buffer_half_float' ? {} : null; } };
  const caps = readRendererCapabilities({ backend: { isWebGLBackend: true, gl } });
  assert.equal(caps.colorTargetHalfFloat, true);
  assert.ok(probed.includes('EXT_color_buffer_half_float'));
});

test('scope disposes reverse order and rejects late publication', () => {
  const scope = new ResourceScope(); const order = [];
  scope.defer(() => order.push(1)); scope.defer(() => order.push(2));
  scope.dispose(); scope.dispose();
  assert.deepEqual(order, [2, 1]);
  assert.throws(() => scope.defer(() => order.push(3)), /disposed/);
  assert.deepEqual(order, [2, 1, 3]);
});
