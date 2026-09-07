/** Backend-specific inspection lives here, never in portable material code. */
export function readRendererCapabilities(renderer) {
  const backend = renderer.backend;
  if (backend?.isWebGPUBackend) {
    const device = backend.device;
    if (!device) throw new Error('WebGPU renderer has no initialized device.');
    return Object.freeze({
      backend: 'webgpu',
      maxTextureSize: device.limits.maxTextureDimension2D,
      maxSamples: 4,
      gpuTiming: device.features.has('timestamp-query'),
      nativeCompute: true,
      indirectDraw: typeof backend.createIndirectStorageAttribute === 'function',
      colorTargetHalfFloat: true,
      sampledDepth: true,
    });
  }
  if (backend?.isWebGLBackend) {
    const gl = backend.gl;
    if (!gl) throw new Error('WebGL renderer has no initialized context.');
    return Object.freeze({
      backend: 'webgl2',
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxSamples: gl.getParameter(gl.MAX_SAMPLES),
      gpuTiming: Boolean(gl.getExtension('EXT_disjoint_timer_query_webgl2')),
      nativeCompute: false,
      indirectDraw: false,
      colorTargetHalfFloat: Boolean(gl.getExtension('EXT_color_buffer_float')),
      sampledDepth: true,
    });
  }
  throw new Error('Renderer initialized an unrecognized backend.');
}
