import { WebGPURenderer } from 'three/webgpu';
import { readRendererCapabilities } from './RendererCapabilities.js';
import {
  collectShaderCompileDiagnostics,
  SHADER_COMPILE_END_EVENT,
  SHADER_COMPILE_START_EVENT,
} from './ShaderCompileDiagnostics.js';

const REQUESTS = new Set(['auto', 'webgpu', 'webgl']);

function dispatchShaderCompileEvent(name, detail) {
  if (typeof globalThis.dispatchEvent !== 'function' || typeof globalThis.CustomEvent !== 'function') return;
  globalThis.dispatchEvent(new CustomEvent(name, { detail }));
}

function instrumentShaderCompilation(renderer, backend) {
  if (typeof renderer.compileAsync !== 'function') return () => {};
  const original = renderer.compileAsync.bind(renderer);
  renderer.compileAsync = async (scene, camera, targetScene) => {
    const diagnostics = collectShaderCompileDiagnostics(scene);
    const startedAt = performance.now();
    dispatchShaderCompileEvent(SHADER_COMPILE_START_EVENT, { backend, diagnostics });
    try {
      return await original(scene, camera, targetScene);
    } finally {
      dispatchShaderCompileEvent(SHADER_COMPILE_END_EVENT, {
        backend,
        diagnostics,
        elapsedMs: performance.now() - startedAt,
      });
    }
  };
  return () => { renderer.compileAsync = original; };
}

export function resolveRendererRequest(search = '', forceWebGL = false, warn = console.warn) {
  const value = new URLSearchParams(search).get('renderer');
  if (REQUESTS.has(value)) return value;
  if (value !== null) warn(`Unknown renderer "${value}"; using configured backend preference.`);
  return forceWebGL ? 'webgl' : 'auto';
}

/** Creation is injectable so init rejection and cleanup can be verified without a GPU. */
export async function createRendererSession({
  request = 'auto',
  options = {},
  signal,
  createRenderer = (parameters) => new WebGPURenderer(parameters),
  readCapabilities = readRendererCapabilities,
} = {}) {
  if (!REQUESTS.has(request)) throw new Error(`Invalid renderer request: ${request}`);
  signal?.throwIfAborted();
  const renderer = createRenderer({ ...options, forceWebGL: request === 'webgl' });
  let disposed = false;
  let disposePromise = null;
  let previousLossHandler;
  let restoreCompileAsync = () => {};
  const lossListeners = new Set();
  const dispose = () => {
    if (disposed) return disposePromise ?? Promise.resolve();
    disposed = true;
    lossListeners.clear();
    restoreCompileAsync();
    if (previousLossHandler) renderer.onDeviceLost = previousLossHandler;
    try { renderer.setAnimationLoop(null); } catch { /* Init may have failed before animation setup. */ }
    try {
      disposePromise = Promise.resolve(renderer.dispose());
      disposePromise.catch((error) => console.warn('Renderer disposal failed.', error));
      return disposePromise;
    } finally {
      renderer.domElement?.remove();
    }
  };
  try {
    await renderer.init();
    signal?.throwIfAborted();
    const capabilities = readCapabilities(renderer);
    if (request === 'webgpu' && capabilities.backend !== 'webgpu') {
      throw new Error('WebGPU was explicitly requested but only WebGL 2 initialized.');
    }
    if (request === 'webgl' && capabilities.backend !== 'webgl2') {
      throw new Error('Forced WebGL 2 initialized an unexpected backend.');
    }
    const diagnostics = Object.freeze({
      requested: request,
      actual: capabilities.backend,
      fallbackReason: request === 'auto' && capabilities.backend === 'webgl2'
        ? 'WebGPU initialization was unavailable; Three.js selected WebGL 2.' : null,
    });
    restoreCompileAsync = instrumentShaderCompilation(renderer, capabilities.backend);
    previousLossHandler = renderer.onDeviceLost;
    renderer.onDeviceLost = (info) => {
      if (disposed) return;
      try { previousLossHandler?.call(renderer, info); } finally {
        for (const listener of lossListeners) {
          try { listener(info); } catch (error) { console.error('Renderer loss listener failed.', error); }
        }
      }
    };
    return {
      renderer, capabilities, diagnostics, dispose,
      subscribeDeviceLoss(listener) {
        if (disposed) return () => {};
        lossListeners.add(listener);
        return () => lossListeners.delete(listener);
      },
    };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { console.warn('Renderer rollback failed.', cleanupError); }
    throw error;
  }
}
