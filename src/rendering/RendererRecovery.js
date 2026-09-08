/** One bounded recovery sequence per page; repeated device failure cannot loop. */
export class RendererRecovery {
  constructor({ capture, release, restart, onFailure }) {
    this.capture = capture;
    this.release = release;
    this.restart = restart;
    this.onFailure = onFailure;
    this.pending = null;
    this.attempts = 0;
    this.disposed = false;
  }

  recover(request, actual, info) {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.#recover(request, actual, info).finally(() => { this.pending = null; });
    return this.pending;
  }

  async #recover(request, actual, info) {
    const errors = [];
    try {
      if (this.attempts >= 2) throw new Error('Renderer recovery budget exhausted. Reload to retry.');
      const state = this.capture();
      this.release();
      const automaticGpuRecovery = request === 'auto' && actual === 'webgpu';
      // A successful first retry can lose its device later. Reserve the second
      // attempt for the fallback instead of spending both attempts on WebGPU.
      const backends = automaticGpuRecovery
        ? (this.attempts === 0 ? ['webgpu', 'webgl'] : ['webgl'])
        : [actual === 'webgpu' ? 'webgpu' : 'webgl'];
      for (const backend of backends) {
        if (this.disposed || this.attempts >= 2) break;
        this.attempts++;
        try {
          await this.restart(backend, state);
          if (this.disposed) this.release();
          return;
        } catch (error) {
          errors.push(error);
          this.release();
        }
      }
      if (!this.disposed) throw new AggregateError(errors, 'Renderer recovery failed.');
    } catch (error) {
      if (!this.disposed) {
        this.release();
        this.onFailure(error, info);
      }
    }
  }

  dispose() { this.disposed = true; }
}
